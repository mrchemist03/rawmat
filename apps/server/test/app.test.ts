import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { buildApp } from "../src/app.js"
import { healthHost, readAppUrl } from "../src/config.js"

const origin = "https://rawmat.example.invalid"
const appUrl = readAppUrl(origin)
const headers = { host: appUrl.host }

describe("server foundation", () => {
  let webRoot: string
  let app: ReturnType<typeof buildApp>

  beforeAll(async () => {
    webRoot = await mkdtemp(join(tmpdir(), "rawmat-web-"))
    await mkdir(join(webRoot, "assets"))
    await writeFile(join(webRoot, "index.html"), '<html lang="ar" dir="rtl"></html>')
    await writeFile(join(webRoot, "assets", "app.js"), "export {}")
    await writeFile(join(webRoot, "other.html"), "Private fixture")

    app = buildApp(appUrl, webRoot, false)
    app.post("/api/fixture", async () => ({ status: "ok" }))
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
    if (webRoot) await rm(webRoot, { recursive: true, force: true })
  })

  test("health returns a minimal, non-cacheable response", async () => {
    const response = await app.inject({ url: "/healthz", headers })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: "ok" })
    expect(response.headers["cache-control"]).toBe("no-store")
  })

  test("only allows the container probe exception from loopback", async () => {
    const probe = { url: "/healthz", headers: { host: healthHost } }

    expect((await app.inject({ ...probe, remoteAddress: "127.0.0.1" })).statusCode).toBe(200)
    expect((await app.inject({ ...probe, remoteAddress: "192.0.2.1" })).statusCode).toBe(400)
    expect((await app.inject({ ...probe, url: "/", remoteAddress: "127.0.0.1" })).statusCode).toBe(400)
  })

  test("serves the shell and built assets with security headers", async () => {
    const response = await app.inject({ url: "/", headers })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('lang="ar" dir="rtl"')
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'")
    expect(response.headers["content-security-policy"]).not.toContain("unsafe-inline")
    expect(response.headers["x-content-type-options"]).toBe("nosniff")
    expect(response.headers["referrer-policy"]).toBe("no-referrer")
    expect(response.headers["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=()")
    expect(response.headers["strict-transport-security"]).toBe("max-age=31536000")
    expect((await app.inject({ url: "/assets/app.js", headers })).statusCode).toBe(200)
    expect((await app.inject({ url: "/other.html", headers })).statusCode).toBe(404)
    expect((await app.inject({ url: "/api/future", headers })).statusCode).toBe(404)
  })

  test("requires the configured request host", async () => {
    const response = await app.inject({ url: "/", headers: { host: "other.example.invalid" } })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: "bad_request" })
    expect(response.headers["strict-transport-security"]).toBeUndefined()
  })

  test("keeps local HTTP available without HSTS", async () => {
    const local = buildApp(readAppUrl("http://127.0.0.1:8080"), webRoot, false)
    try {
      const response = await local.inject({ url: "/healthz", headers: { host: healthHost } })
      expect(response.statusCode).toBe(200)
      expect(response.headers["strict-transport-security"]).toBeUndefined()
    } finally {
      await local.close()
    }
  })

  test("requires the configured origin on writes", async () => {
    const request = { method: "POST" as const, url: "/api/fixture" }

    expect((await app.inject({ ...request, headers })).statusCode).toBe(403)
    expect((await app.inject({ ...request, headers: { ...headers, origin } })).statusCode).toBe(200)
  })
})

describe("APP_URL", () => {
  test("requires a valid origin without a path", () => {
    expect(() => readAppUrl(undefined)).toThrow("APP_URL")
    expect(() => readAppUrl("http://rawmat.example.invalid")).toThrow("APP_URL")
    expect(() => readAppUrl(`${origin}/app`)).toThrow("APP_URL")
    expect(readAppUrl("http://127.0.0.1:8080").origin).toBe("http://127.0.0.1:8080")
  })
})
