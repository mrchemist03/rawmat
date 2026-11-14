import { join } from "node:path"
import fastifyStatic from "@fastify/static"
import { healthResponseSchema, meSchema } from "@rawmat/shared"
import Fastify, { LogController } from "fastify"
import { z } from "zod"
import { healthHost } from "./config.js"
import { readBrandLogo } from "./branding.js"
import { can, navigationFor } from "./modules/auth/permissions.js"
import { registerAuth } from "./modules/auth/routes.js"
import type { AuthOptions } from "./modules/auth/routes.js"
import { challengeOrigin } from "./modules/auth/turnstile.js"
import { registerCatalogue } from "./modules/catalogue/routes.js"
import { registerManagement } from "./modules/management/routes.js"
import { registerAudit } from "./modules/management/audit.js"

const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ")

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"])
const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

export function buildApp(
  appUrl: URL,
  webRoot: string,
  logger = true,
  auth?: AuthOptions & { trustProxy: string | false; brandingRoot?: string },
) {
  const app = Fastify({
    logger,
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    trustProxy: auth?.trustProxy ?? false,
    bodyLimit: 1024 * 1024,
    requestTimeout: 30_000,
  })

  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("Content-Security-Policy", csp)
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Frame-Options", "DENY")

    const host = request.headers.host?.toLowerCase()
    // The container probe uses the actual socket peer and a literal URL.
    const localProbe = request.method === "GET" &&
      request.raw.url === "/healthz" &&
      host === healthHost &&
      loopbackAddresses.has(request.raw.socket.remoteAddress ?? "")

    if (host !== appUrl.host && !localProbe) {
      return reply.code(400).send({ error: "bad_request" })
    }

    if (!safeMethods.has(request.method) && request.headers.origin !== appUrl.origin) {
      return reply.code(403).send({ error: "forbidden" })
    }
  })

  app.addHook("onResponse", async (request, reply) => {
    request.log.info({ statusCode: reply.statusCode }, "request completed")
  })

  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send({ error: "not_found" })
  })

  app.setErrorHandler((error, request, reply) => {
    const status = error instanceof Error && "statusCode" in error ? error.statusCode : undefined
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 500) {
      return reply.code(status).send({ error: "request_rejected" })
    }
    request.log.error("request failed")
    return reply.code(500).send({ error: "internal_error" })
  })

  app.get("/healthz", {
    schema: { response: { 200: z.toJSONSchema(healthResponseSchema) } },
  }, async () => healthResponseSchema.parse({ status: "ok" }))

  app.register(fastifyStatic, {
    root: join(webRoot, "assets"),
    prefix: "/assets/",
    wildcard: true,
    index: false,
    cacheControl: false,
  })

  app.get("/branding/logo.png", async (_request, reply) => {
    const logo = await readBrandLogo(auth?.brandingRoot ?? "branding")
    if (logo) return reply.type("image/png").send(logo)
    return reply.sendFile("rawmat-logo.png", webRoot, { cacheControl: false }).type("image/png")
  })

  if (auth) {
    app.register(async (scope) => {
      const access = await registerAuth(scope, auth)
      registerManagement(scope, access, auth)
      registerCatalogue(scope, access, auth)
      registerAudit(scope, access, auth.db)
      const meError = z.toJSONSchema(z.strictObject({ error: z.string() }))
      scope.get("/api/me", {
        schema: { response: { 200: z.toJSONSchema(meSchema), 401: meError, 403: meError } },
      }, async (request, reply) => {
        const principal = access.touch(request, reply)
        if (!principal) return reply.code(401).send({ error: "sign_in_required" })
        if (principal.mustChangePassword) return reply.code(403).send({ error: "password_change_required" })
        return { name: principal.name, navigation: navigationFor(principal.role) }
      })
      scope.get("/", async (request, reply) => {
        if (!access.principal(request)) return reply.redirect("/login")
        return reply.sendFile("index.html", webRoot, { cacheControl: false })
      })
      for (const [path, permission] of [
        ["/accounts", "manageAccounts"], ["/branches", "manageBranches"],
        ["/materials", "viewWorkspace"], ["/references", "manageReferenceData"],
        ["/audit", "viewAudit"],
      ] as const) {
        scope.get(path, async (request, reply) => {
          const principal = access.principal(request)
          if (!principal || principal.mustChangePassword || !can(principal.role, permission)) {
            return reply.code(404).send({ error: "not_found" })
          }
          return reply.sendFile("index.html", webRoot, { cacheControl: false })
        })
      }
      scope.get("/login", async (request, reply) => {
        if (access.principal(request)) return reply.redirect("/")
        if (auth.config.turnstile) {
          const loginCsp = csp.replace("script-src 'self'", `script-src 'self' ${challengeOrigin}`)
          reply.header("Content-Security-Policy", `${loginCsp}; frame-src ${challengeOrigin}`)
        }
        return reply.sendFile("index.html", webRoot, { cacheControl: false })
      })
    })
  } else {
    app.get("/", async (_request, reply) => reply.sendFile("index.html", webRoot, { cacheControl: false }))
  }

  return app
}
