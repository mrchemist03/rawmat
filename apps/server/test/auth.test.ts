import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import { buildApp } from "../src/app.js"
import { readServerConfig } from "../src/config.js"
import { openDatabase } from "../src/db/database.js"
import { sessions, users } from "../src/db/schema.js"
import { hashPassword } from "../src/modules/auth/passwords.js"
import { createAuthRepository, idleTimeout } from "../src/modules/auth/repository.js"
import { verifyTurnstile } from "../src/modules/auth/turnstile.js"

const origin = "https://rawmat.example.invalid"
const headers = { host: "rawmat.example.invalid", origin }
const initialPassword = "initial password for tests"
const newPassword = "replacement password for tests"
const minute = 60_000

let webRoot: string
let database: ReturnType<typeof openDatabase>
let app: ReturnType<typeof buildApp>
let clock: number
let passwordHash: string

function createTestApp(overrides?: Partial<NonNullable<Parameters<typeof buildApp>[3]>>) {
  const config = readServerConfig({ APP_URL: origin })
  return buildApp(config.appUrl, webRoot, false, {
    config, db: database.db, now: () => clock, trustProxy: false, ...overrides,
  })
}

function login(loginName = "first.user", password = initialPassword, remoteAddress = "192.0.2.1",
  token?: string, forwarded?: string) {
  return app.inject({
    method: "POST", url: "/api/auth/login", remoteAddress,
    headers: { ...headers, "x-forwarded-for": forwarded ?? remoteAddress },
    payload: { loginName, password, turnstileToken: token },
  })
}

function cookieValue(response: { headers: Record<string, unknown> }) {
  const value = response.headers["set-cookie"]
  expect(typeof value).toBe("string")
  return String(value).split(";")[0]!
}

function session(cookie: string) {
  return app.inject({ url: "/api/auth/session", headers: { ...headers, cookie } })
}

beforeAll(async () => {
  webRoot = await mkdtemp(join(tmpdir(), "rawmat-auth-"))
  await mkdir(join(webRoot, "assets"))
  await writeFile(join(webRoot, "index.html"), "<html></html>")
  passwordHash = await hashPassword(initialPassword)
})

beforeEach(() => {
  database = openDatabase(":memory:")
  clock = Date.UTC(2026, 0, 1)
})

afterEach(async () => {
  await app?.close()
  database.close()
})

afterAll(async () => {
  await rm(webRoot, { recursive: true, force: true })
})

describe("authentication", () => {
  test("provisions only once, rotates passwords and sessions, and logs out", async () => {
    const repository = createAuthRepository(database.db)
    expect(repository.bootstrapUser("حساب اختبار", "first.user", passwordHash, clock)).toBe(true)
    expect(repository.bootstrapUser("حساب آخر", "other.user", passwordHash, clock)).toBe(false)
    app = createTestApp()
    expect((await app.inject({ url: "/", headers })).headers.location).toBe("/login")
    const entered = await login(" First.User ")
    expect(entered.statusCode).toBe(200)
    expect(entered.json()).toEqual({ name: "حساب اختبار", mustChangePassword: true })
    expect(entered.headers["set-cookie"]).toMatch(/^__Host-rawmat=.*; Path=\/; HttpOnly; Secure; SameSite=Strict/)
    const original = cookieValue(entered)
    const otherSession = cookieValue(await login())
    expect(database.db.select().from(sessions).all()).toHaveLength(2)
    expect(database.db.select().from(sessions).get()?.tokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect((await app.inject({ url: "/", headers: { ...headers, cookie: original } })).statusCode).toBe(200)
    expect((await session(original)).statusCode).toBe(200)

    const change = await app.inject({
      method: "POST", url: "/api/auth/password", headers: { ...headers, cookie: original },
      payload: { currentPassword: initialPassword, newPassword },
    })
    expect(change.statusCode).toBe(200)
    expect(change.json()).toEqual({ name: "حساب اختبار", mustChangePassword: false })
    expect((await session(original)).statusCode).toBe(401)
    expect((await session(otherSession)).statusCode).toBe(401)
    const rotated = cookieValue(change)
    expect((await session(rotated)).statusCode).toBe(200)
    expect((await login()).statusCode).toBe(401)
    expect((await login("first.user", newPassword)).statusCode).toBe(200)

    const rejectedLogout = await app.inject({
      method: "POST", url: "/api/auth/logout", headers: { host: headers.host, cookie: rotated },
    })
    expect(rejectedLogout.statusCode).toBe(403)
    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { ...headers, cookie: rotated } })
    expect(logout.statusCode).toBe(204)
    expect(logout.headers["set-cookie"]).toMatch(/(?:Expires=Thu, 01 Jan 1970|Max-Age=0)/)
    expect((await session(rotated)).statusCode).toBe(401)
  })

  test("refreshes inactivity and revokes sessions on expiry, disabling and role changes", async () => {
    createAuthRepository(database.db).bootstrapUser("Fixture", "first.user", passwordHash, clock)
    app = createTestApp()
    const first = cookieValue(await login())
    clock += idleTimeout - 1
    expect((await session(first)).statusCode).toBe(200)
    clock += idleTimeout
    expect((await session(first)).statusCode).toBe(401)
    const second = cookieValue(await login())
    database.db.update(users).set({ active: false }).where(eq(users.loginName, "first.user")).run()
    expect((await session(second)).statusCode).toBe(401)
    database.db.update(users).set({ active: true }).where(eq(users.loginName, "first.user")).run()
    expect((await session(second)).statusCode).toBe(401)
    const third = cookieValue(await login())
    database.db.update(users).set({ role: "admin" }).where(eq(users.loginName, "first.user")).run()
    expect((await session(third)).statusCode).toBe(401)
  })

  test("limits normalized accounts across addresses and resets after 15 minutes", async () => {
    createAuthRepository(database.db).bootstrapUser("Fixture", "first.user", passwordHash, clock)
    app = createTestApp()
    for (let count = 1; count <= 5; count++) {
      const response = await login(" FIRST.USER ", "wrong password", `192.0.2.${count}`)
      expect(response.statusCode).toBe(401)
      expect(response.json()).toEqual({ error: "invalid_credentials" })
    }
    expect((await login("first.user", initialPassword, "192.0.2.12")).statusCode).toBe(429)
    clock += 15 * minute
    expect((await login("first.user", initialPassword, "192.0.2.12")).statusCode).toBe(200)
  })

  test("limits each direct address across accounts without trusting forwarding headers", async () => {
    app = createTestApp({ trustProxy: "198.51.100.0/24" })
    for (let count = 1; count <= 5; count++) {
      const response = await login(`unknown-${count}`, "wrong password", "192.0.2.1", undefined, `192.0.2.${count + 10}`)
      expect(response.statusCode).toBe(401)
      expect(response.json()).toEqual({ error: "invalid_credentials" })
    }
    expect((await login("unknown-user")).statusCode).toBe(429)
    expect((await login("other-user", initialPassword, "198.51.100.2", undefined, "203.0.113.2")).statusCode).toBe(401)
  })

  test("persists attempt limits across database reopen", async () => {
    const directory = await mkdtemp(join(webRoot, "db-"))
    const path = join(directory, "auth.sqlite")
    let file = openDatabase(path)
    try {
      const repository = createAuthRepository(file.db)
      for (let index = 0; index < 5; index++) {
        expect(repository.reserveLoginAttempt("fixture-account", String(index), clock)).toBe(true)
      }
    } finally {
      file.close()
    }
    file = openDatabase(path)
    try {
      expect(createAuthRepository(file.db).reserveLoginAttempt("fixture-account", "new-address", clock)).toBe(false)
    } finally {
      file.close()
    }
  })

  test("requires the challenge and rejects replays before creating a session", async () => {
    const config = readServerConfig({ APP_URL: origin, TURNSTILE_SITE_KEY: "fixture-site", TURNSTILE_SECRET_KEY: "fixture-secret" })
    const verify = vi.fn<typeof verifyTurnstile>()
      .mockResolvedValueOnce("unavailable").mockResolvedValue("verified")
    createAuthRepository(database.db).bootstrapUser("Fixture", "first.user", passwordHash, clock)
    app = createTestApp({ config, verifyChallenge: verify })
    expect((await app.inject({ url: "/api/auth/config", headers })).json()).toEqual({ turnstileSiteKey: "fixture-site" })
    expect((await app.inject({ url: "/login", headers })).headers["content-security-policy"]).toContain("https://challenges.cloudflare.com")
    expect((await app.inject({ url: "/healthz", headers })).headers["content-security-policy"]).not.toContain("cloudflare.com")
    expect((await login()).json()).toEqual({ error: "challenge_required" })
    expect(verify).not.toHaveBeenCalled()
    expect((await login("first.user", initialPassword, "192.0.2.1", "fixture-token")).json())
      .toEqual({ error: "challenge_unavailable" })
    expect(database.db.select().from(sessions).all()).toHaveLength(0)
    const success = await login("first.user", initialPassword, "192.0.2.1", "fixture-token")
    expect(success.statusCode).toBe(200)
    expect((await app.inject({ url: "/", headers: { ...headers, cookie: cookieValue(success) } }))
      .headers["content-security-policy"]).not.toContain("cloudflare.com")
    expect((await login("first.user", initialPassword, "192.0.2.1", "fixture-token")).json())
      .toEqual({ error: "challenge_required" })
  })

  test("leaves no open registration endpoint and enforces foreign keys", async () => {
    app = createTestApp()
    expect((await app.inject({ method: "POST", url: "/api/auth/register", headers })).statusCode).toBe(404)
    expect(() => database.db.insert(sessions).values({
      tokenHash: "fixture", userId: randomUUID(), expiresAt: clock, lastActiveAt: clock,
    }).run()).toThrow()
  })
})

test("validates the Turnstile hostname, action, payload and upstream health", async () => {
  const valid = { success: true, hostname: headers.host, action: "login" }
  const verify = (body: unknown) => verifyTurnstile("fixture-token", "fixture-secret", headers.host,
    async () => Response.json(body))
  expect(await verify(valid)).toBe("verified")
  expect(await verify({ ...valid, hostname: "other.example.invalid" })).toBe("rejected")
  expect(await verify({ ...valid, action: "other" })).toBe("rejected")
  expect(await verify({ success: false, "error-codes": ["timeout-or-duplicate"] })).toBe("rejected")
  expect(await verify({ success: false, "error-codes": ["internal-error"] })).toBe("unavailable")
  expect(await verify({ ...valid, extra: "x".repeat(17_000) })).toBe("unavailable")
  expect(await verifyTurnstile("fixture-token", "fixture-secret", headers.host, async () => {
    throw new Error("Offline fixture")
  })).toBe("unavailable")
})

test("requires HTTPS and a persistent secret in production", () => {
  expect(() => readServerConfig({ APP_URL: origin, NODE_ENV: "production" })).toThrow("SESSION_SECRET")
  expect(() => readServerConfig({
    APP_URL: "http://127.0.0.1:8080", NODE_ENV: "production", SESSION_SECRET: randomBytes(32).toString("hex"),
  })).toThrow("HTTPS")
  expect(() => readServerConfig({ APP_URL: origin, TURNSTILE_SITE_KEY: "fixture-site" })).toThrow("Turnstile")
  expect(() => readServerConfig({ APP_URL: origin, TRUSTED_PROXY_CIDR: "loopback" })).toThrow()
})
