import { createHash, createHmac, randomBytes } from "node:crypto"
import cookie from "@fastify/cookie"
import { changePasswordSchema, loginConfigSchema, loginSchema, sessionViewSchema } from "@rawmat/shared"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import ipaddr from "ipaddr.js"
import { z } from "zod"
import type { readServerConfig } from "../../config.js"
import type { AppDatabase } from "../../db/database.js"
import { hashPassword, verifyPassword } from "./passwords.js"
import { createAuthRepository, idleTimeout } from "./repository.js"
import { verifyTurnstile } from "./turnstile.js"

type AuthConfig = Pick<ReturnType<typeof readServerConfig>, "appUrl" | "sessionSecret" | "turnstile">
export type AuthOptions = {
  config: AuthConfig
  db: AppDatabase
  now?: () => number
  verifyChallenge?: typeof verifyTurnstile
}

const sessionCookie = "__Host-rawmat"
const cookieOptions = { path: "/", secure: true, httpOnly: true, sameSite: "strict" } as const

function digest(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

function clientAddress(request: FastifyRequest) {
  return ipaddr.isValid(request.ip) ? ipaddr.process(request.ip).toString() : "unknown"
}

function getSessionHash(request: FastifyRequest) {
  const value = request.cookies[sessionCookie]
  if (!value) return
  const unsigned = request.unsignCookie(value)
  if (unsigned.valid && unsigned.value && /^[\w-]{43}$/.test(unsigned.value)) {
    return digest(unsigned.value)
  }
}

function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(sessionCookie, token, { ...cookieOptions, signed: true, maxAge: idleTimeout / 1_000 })
}

function sessionView(user: z.infer<typeof sessionViewSchema>) {
  return { name: user.name, mustChangePassword: user.mustChangePassword }
}

export async function registerAuth(app: FastifyInstance, options: AuthOptions) {
  const { config, db, now = Date.now, verifyChallenge = verifyTurnstile } = options
  const repository = createAuthRepository(db)
  const dummyHash = await hashPassword(randomBytes(32).toString("base64url"))
  let pendingChallenges = 0
  let pendingPasswords = 0

  const keyed = (scope: string, value: string) =>
    createHmac("sha256", config.sessionSecret).update(scope).update("\0").update(value).digest("hex")
  const rejected = (reply: FastifyReply) => reply.code(401).send({ error: "invalid_credentials" })
  const busy = (reply: FastifyReply) => reply.header("Retry-After", "2").code(503).send({ error: "try_later" })
  const limited = (reply: FastifyReply) => reply.header("Retry-After", "900").code(429).send({ error: "rate_limited" })
  const errorResponse = z.toJSONSchema(z.strictObject({ error: z.string() }))
  const sessionResponse = { response: {
    200: z.toJSONSchema(sessionViewSchema), 400: errorResponse, 401: errorResponse,
    429: errorResponse, 503: errorResponse,
  } }

  await app.register(cookie, { secret: config.sessionSecret })

  app.get("/api/auth/config", {
    schema: { response: { 200: z.toJSONSchema(loginConfigSchema) } },
  }, async () => ({ turnstileSiteKey: config.turnstile?.siteKey ?? null }))

  app.post("/api/auth/login", { bodyLimit: 4_096, schema: sessionResponse }, async (request, reply) => {
    const input = loginSchema.safeParse(request.body)
    if (!input.success) return rejected(reply)
    if (pendingPasswords >= 2 || pendingChallenges >= 16) return busy(reply)

    const { loginName, password, turnstileToken } = input.data
    if (!repository.reserveLoginAttempt(keyed("account", loginName), keyed("address", clientAddress(request)), now())) {
      return limited(reply)
    }

    const turnstile = config.turnstile
    if (turnstile) {
      if (!turnstileToken) return reply.code(400).send({ error: "challenge_required" })
      pendingChallenges += 1
      try {
        const verdict = await verifyChallenge(turnstileToken, turnstile.secretKey, config.appUrl.hostname)
        if (verdict === "unavailable") return reply.code(503).send({ error: "challenge_unavailable" })
        if (verdict !== "verified" || !repository.redeemTurnstile(digest(turnstileToken), now())) {
          return reply.code(400).send({ error: "challenge_required" })
        }
      } finally {
        pendingChallenges -= 1
      }
    }

    if (pendingPasswords >= 2) return busy(reply)
    pendingPasswords += 1
    try {
      const user = repository.findUser(loginName)
      const match = await verifyPassword(password, user?.passwordHash ?? dummyHash)
      if (!match || !user) return rejected(reply)
      const token = randomBytes(32).toString("base64url")
      const session = repository.replaceLoginSession(user.id, user.passwordHash, getSessionHash(request), digest(token), now())
      if (!session) return rejected(reply)
      setSessionCookie(reply, token)
      return sessionView(session)
    } finally {
      pendingPasswords -= 1
    }
  })

  app.get("/api/auth/session", { schema: sessionResponse }, async (request, reply) => {
    const tokenHash = getSessionHash(request)
    const session = tokenHash && repository.touchSession(tokenHash, now())
    if (!session) return reply.code(401).send({ error: "sign_in_required" })
    // Refresh the browser cookie and SQLite expiration together.
    const signed = request.cookies[sessionCookie]
    if (signed) reply.setCookie(sessionCookie, signed, { ...cookieOptions, maxAge: idleTimeout / 1_000 })
    return sessionView(session)
  })

  app.post("/api/auth/logout", async (request, reply) => {
    const tokenHash = getSessionHash(request)
    if (tokenHash) repository.deleteSession(tokenHash)
    return reply.clearCookie(sessionCookie, cookieOptions).code(204).send()
  })

  app.post("/api/auth/password", { bodyLimit: 4_096, schema: sessionResponse }, async (request, reply) => {
    const tokenHash = getSessionHash(request)
    const user = tokenHash && repository.passwordForSession(tokenHash, now())
    if (!tokenHash || !user) return reply.code(401).send({ error: "sign_in_required" })
    const input = changePasswordSchema.safeParse(request.body)
    if (!input.success || input.data.currentPassword === input.data.newPassword) {
      return reply.code(400).send({ error: "invalid_password" })
    }
    if (pendingPasswords >= 2) return busy(reply)
    if (!repository.reserveLoginAttempt(
      keyed("change-password-account", user.id), keyed("change-password-address", clientAddress(request)), now(),
    )) return limited(reply)
    pendingPasswords += 1
    try {
      if (!await verifyPassword(input.data.currentPassword, user.passwordHash)) return rejected(reply)
      const passwordHash = await hashPassword(input.data.newPassword)
      const token = randomBytes(32).toString("base64url")
      const session = repository.changePassword(tokenHash, user.id, user.passwordHash, passwordHash, digest(token), now())
      if (!session) return reply.code(401).send({ error: "sign_in_required" })
      setSessionCookie(reply, token)
      return sessionView(session)
    } finally {
      pendingPasswords -= 1
    }
  })

  return {
    hasSession(request: FastifyRequest) {
      const tokenHash = getSessionHash(request)
      return Boolean(tokenHash && repository.findSession(tokenHash, now()))
    },
  }
}
