import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import { buildApp } from "../src/app.js"
import { readBrandTheme } from "../src/branding.js"
import { readServerConfig } from "../src/config.js"
import { openDatabase } from "../src/db/database.js"

let root: string
let branding: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rawmat-branding-"))
  branding = join(root, "branding")
  await mkdir(branding)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

test("reloads the local theme at request time with CSS content type and no raw configuration endpoint", async () => {
  await mkdir(join(root, "assets"))
  const db = openDatabase(":memory:")
  const config = readServerConfig({ APP_URL: "https://rawmat.example.invalid" })
  const app = buildApp(config.appUrl, root, false, { config, db: db.db, trustProxy: false, brandingRoot: branding })
  const get = (url = "/branding/theme.css") => app.inject({ url, headers: { host: config.appUrl.host } })
  try {
    expect((await get()).body).toBe("")
    await writeFile(join(branding, "theme.json"), '{"primaryColor":"#3366CC"}')
    const response = await get()
    expect(response.statusCode).toBe(200)
    expect(response.headers["content-type"]).toContain("text/css")
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(response.headers["x-content-type-options"]).toBe("nosniff")
    expect(response.headers["content-security-policy"]).toContain("style-src 'self'")
    expect(response.headers["content-security-policy"]).not.toContain("unsafe-inline")
    expect(response.body).toContain("--primary:#3366cc;")
    await writeFile(join(branding, "theme.json"), '{"primaryColor":"#aa2266"}')
    expect((await get()).body).toContain("--primary:#aa2266;")
    expect((await get("/branding/theme.json")).statusCode).toBe(404)
    expect((await app.inject({ method: "POST", url: "/branding/theme.css", headers: {
      host: config.appUrl.host, origin: config.appUrl.origin,
    }, payload: { primaryColor: "#000000" } })).statusCode).toBe(404)
    await rm(join(branding, "theme.json"))
    expect((await get()).body).toBe("")
  } finally { await app.close(); db.close() }
})

test("falls back to bundled colors for invalid, oversized, or non-file settings without reflecting input", async () => {
  for (const content of ["", "not json", "null", "[]", '{}', '{"primaryColor":"red"}',
    '{"primaryColor":"#abc"}', '{"primaryColor":"#12345678"}', '{"primaryColor":"#123456; background:url(https://example.invalid)"}',
    '{"primaryColor":"#123456","private":"fixture"}', ' '.repeat(1025) + '{"primaryColor":"#123456"}']) {
    await writeFile(join(branding, "theme.json"), content)
    expect(await readBrandTheme(branding)).toBe("")
  }
  await rm(join(branding, "theme.json"))
  await mkdir(join(branding, "theme.json"))
  expect(await readBrandTheme(branding)).toBe("")
})

test.skipIf(process.platform === "win32")("does not follow a theme symlink outside the branding directory", async () => {
  const outside = join(root, "outside.json")
  await writeFile(outside, '{"primaryColor":"#123456"}')
  await symlink(outside, join(branding, "theme.json"))
  expect(await readBrandTheme(branding)).toBe("")
})

function brightness(hex: string) {
  const channels = hex.slice(1).match(/../g)!.map((part) => {
    const channel = parseInt(part, 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
}

function contrast(first: string, second: string) {
  const values = [brightness(first), brightness(second)].sort((a, b) => a - b)
  return (values[1]! + 0.05) / (values[0]! + 0.05)
}

test("derives readable button labels and text for dark, light and saturated primary colors", async () => {
  for (const primaryColor of ["#000000", "#ffffff", "#ffff00", "#ff0000", "#00ff00", "#0000ff", "#808080", "#3366cc", "#145a46"]) {
    await writeFile(join(branding, "theme.json"), JSON.stringify({ primaryColor }))
    const css = await readBrandTheme(branding)
    const values = Object.fromEntries([...css.matchAll(/--([a-z-]+):(#[\da-f]+);/g)].map((match) => [match[1], match[2]]))
    expect(css).toMatch(/^:root:root\{(?:--[a-z-]+:#[\da-f]{6,8};)+\}\n$/)
    expect(values.primary).toBe(primaryColor)
    expect(contrast(values.primary!, values["on-primary"]!)).toBeGreaterThanOrEqual(4.5)
    for (const name of ["primary-text", "brand-text", "brand-label", "brand-muted"]) {
      expect(contrast(values[name]!, "#ffffff")).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(values["brand-text"]!, values["soft-bg"]!)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(values["brand-muted"]!, values["hover-bg"]!)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(values["primary-border"]!, "#ffffff")).toBeGreaterThanOrEqual(3)
    expect(contrast(values["control-line"]!, "#ffffff")).toBeGreaterThanOrEqual(3)
  }
})
