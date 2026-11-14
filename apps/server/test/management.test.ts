import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { crc32 } from "node:zlib"
import { afterAll, beforeAll, expect, test } from "vitest"
import { buildApp } from "../src/app.js"
import { readServerConfig } from "../src/config.js"
import { openDatabase } from "../src/db/database.js"
import { auditLog, materials, users } from "../src/db/schema.js"
import { hashPassword } from "../src/modules/auth/passwords.js"
import { can } from "../src/modules/auth/permissions.js"

const origin = "https://rawmat.example.invalid"
const headers = { host: "rawmat.example.invalid", origin }
const fixturePassword = "workspace fixture password"
const accountName = "حساب إدارة تجريبي"
const png = new URL("../../web/public/rawmat-logo.png", import.meta.url)
const database = openDatabase(":memory:")
let root: string
let app: ReturnType<typeof buildApp>
let manager = ""
let admin = ""
let basic = ""
const ids = { manager: randomUUID(), admin: randomUUID(), basic: randomUUID(), pending: randomUUID() }

async function login(loginName: string, remoteAddress: string, password = fixturePassword) {
  const response = await app.inject({
    method: "POST", url: "/api/auth/login", headers, remoteAddress, payload: { loginName, password },
  })
  expect(response.statusCode).toBe(200)
  expect(response.json()).not.toHaveProperty("role")
  return String(response.headers["set-cookie"]).split(";")[0]!
}

function get(url: string, cookie?: string) {
  return app.inject({ url, headers: cookie ? { ...headers, cookie } : headers })
}

function write(url: string, cookie: string, payload: Record<string, unknown>, method: "POST" | "PUT" = "POST") {
  return app.inject({ method, url, headers: { ...headers, cookie }, payload })
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "rawmat-management-"))
  await mkdir(join(root, "assets"))
  await mkdir(join(root, "branding"))
  await writeFile(join(root, "index.html"), "<html></html>")
  await writeFile(join(root, "rawmat-logo.png"), await readFile(png))
  const passwordHash = await hashPassword(fixturePassword)
  database.db.insert(users).values([
    { id: ids.manager, name: accountName, loginName: "manager.fixture", role: "superuser", passwordHash, mustChangePassword: false },
    { id: ids.admin, name: "Admin fixture", loginName: "admin.fixture", role: "admin", passwordHash, mustChangePassword: false },
    { id: ids.basic, name: "Basic fixture", loginName: "basic.fixture", role: "user", passwordHash, mustChangePassword: false },
    { id: ids.pending, name: "Pending fixture", loginName: "pending.fixture", role: "superuser", passwordHash },
  ]).run()
  const config = readServerConfig({ APP_URL: origin })
  app = buildApp(config.appUrl, root, false, {
    config, db: database.db, trustProxy: false, brandingRoot: join(root, "branding"),
  })
  manager = await login("manager.fixture", "192.0.2.1")
  admin = await login("admin.fixture", "192.0.2.2")
  basic = await login("basic.fixture", "192.0.2.3")
}, 15_000)

afterAll(async () => {
  await app?.close()
  database.close()
  if (root) await rm(root, { recursive: true, force: true })
})

test("grants purchase approvals to the intended roles and keeps management restricted", () => {
  expect(can("user", "viewCosts")).toBe(false)
  expect(can("admin", "viewCosts")).toBe(true)
  expect(can("admin", "approvePurchases")).toBe(true)
  expect(can("admin", "manageAccounts")).toBe(false)
  expect(can("superuser", "manageAccounts")).toBe(true)
})

test("returns only name and navigation for each role and withholds management routes", async () => {
  expect((await get("/api/me", manager)).json()).toEqual({
    name: accountName, navigation: ["account", "materials", "purchases", "accounts", "branches", "references", "audit"],
  })
  expect((await get("/api/me", admin)).json()).toEqual({ name: "Admin fixture", navigation: ["account", "materials", "purchases"] })
  expect((await get("/api/me", basic)).json()).toEqual({ name: "Basic fixture", navigation: ["account", "materials", "purchases"] })
  expect((await get("/api/me")).statusCode).toBe(401)
  for (const cookie of [undefined, admin, basic]) {
    for (const path of ["/accounts", "/branches", "/references", "/api/manage/accounts", "/api/manage/branches", "/api/manage/catalogue/suppliers"]) {
      expect((await get(path, cookie)).statusCode).toBe(404)
    }
  }
  const pending = await login("pending.fixture", "192.0.2.4")
  expect((await get("/api/me", pending)).statusCode).toBe(403)
  expect((await get("/api/manage/accounts", pending)).statusCode).toBe(404)
  expect((await write("/api/manage/branches", basic, { name: "Test", city: "Test" })).statusCode).toBe(404)
})

test("manages accounts and branches, revokes altered sessions and audits writes", async () => {
  const branch = { name: "الشعبة التجريبية", city: "المدينة التجريبية" }
  expect((await write("/api/manage/branches", manager, branch)).statusCode).toBe(204)
  expect((await write("/api/manage/branches", manager, branch)).statusCode).toBe(409)
  const branchList = (await get("/api/manage/branches?search=" + encodeURIComponent(branch.name), manager)).json()
  expect(branchList.total).toBe(1)
  const branchId = branchList.items[0].id

  const account = { name: "اسم تجريبي", loginName: "Managed.Fixture", branchId }
  const temporaryPassword = "temporary password fixture"
  expect((await write("/api/manage/accounts", manager, {
    ...account, accountType: "admin", temporaryPassword,
  })).statusCode).toBe(204)
  expect((await write("/api/manage/accounts", manager, {
    ...account, accountType: "user", temporaryPassword,
  })).statusCode).toBe(409)
  const accountList = (await get("/api/manage/accounts?search=managed.fixture", manager)).json()
  const id = accountList.items[0].id
  expect(accountList.items[0]).toEqual({
    id, name: account.name, loginName: "managed.fixture", branchName: branch.name, branchId,
    active: true, isCurrentAccount: false,
  })
  const cookie = await login("managed.fixture", "192.0.2.5", temporaryPassword)
  expect((await get("/api/me", cookie)).statusCode).toBe(403)
  expect((await write(`/api/manage/accounts/${id}`, manager, {
    ...account, active: false, accountType: "user",
  }, "PUT")).statusCode).toBe(204)
  expect((await get("/api/auth/session", cookie)).statusCode).toBe(401)

  expect((await write(`/api/manage/branches/${branchId}`, manager, { ...branch, active: false }, "PUT")).statusCode).toBe(204)
  expect((await write("/api/manage/accounts", manager, {
    ...account, loginName: "other.fixture", accountType: "user", temporaryPassword,
  })).json()).toEqual({ error: "invalid_branch" })
  expect((await write(`/api/manage/accounts/${ids.manager}`, manager, {
    name: accountName, loginName: "manager.fixture", branchId: null, active: false,
  }, "PUT")).json()).toEqual({ error: "protected_account" })
  expect((await write(`/api/manage/accounts/${ids.manager}`, manager, {
    name: accountName, loginName: "manager.fixture", branchId: null, active: true, accountType: "user",
  }, "PUT")).json()).toEqual({ error: "protected_account" })
  const audit = database.db.select().from(auditLog).all()
  expect(audit.map((record) => record.action)).toEqual(["branch_created", "account_created", "account_updated", "branch_updated"])
  expect(audit.every((record) => record.actorId === ids.manager)).toBe(true)
})

test("serves the fallback and accepts only a bounded PNG from the branding directory", async () => {
  const fallback = await get("/branding/logo.png")
  expect(fallback.statusCode).toBe(200)
  expect(fallback.headers["content-type"]).toBe("image/png")
  expect(fallback.headers["x-content-type-options"]).toBe("nosniff")
  const bytes = await readFile(png)
  expect(fallback.rawPayload.equals(bytes)).toBe(true)
  const logo = join(root, "branding", "logo.png")
  await writeFile(logo, "<svg/>")
  expect((await get("/branding/logo.png")).rawPayload.equals(bytes)).toBe(true)

  // A second valid PNG differs in one ancillary textual chunk.
  const chunk = Buffer.from("000000057445587461006c616200000000", "hex")
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4)
  const replacement = Buffer.concat([bytes.subarray(0, -12), chunk, bytes.subarray(-12)])
  await writeFile(logo, replacement)
  const custom = await get("/branding/logo.png")
  expect(custom.headers["cache-control"]).toBe("no-store")
  expect(custom.rawPayload.equals(replacement)).toBe(true)
})

test("creates, edits, searches, archives and restores materials with the intended permissions", async () => {
  expect((await get("/api/materials")).statusCode).toBe(404)
  expect((await get("/materials", basic)).statusCode).toBe(200)
  expect((await get("/references", manager)).statusCode).toBe(200)
  expect((await write("/api/manage/catalogue/categories", admin, { name: "فئة المواد" })).statusCode).toBe(404)

  const references = {
    categories: { name: "مساحيق" },
    units: { name: "كغ" },
    suppliers: { name: "مورد تجريبي", contact: "تواصل تجريبي", notes: "ملاحظة إدارية" },
  }
  const keys = {} as Record<keyof typeof references, string>
  for (const kind of ["categories", "units", "suppliers"] as const) {
    expect((await write(`/api/manage/catalogue/${kind}`, manager, references[kind])).statusCode).toBe(204)
    expect((await write(`/api/manage/catalogue/${kind}`, manager, references[kind])).statusCode).toBe(409)
    const item = (await get(`/api/catalogue/${kind}`, basic)).json().items[0]
    expect(item).toEqual({ id: expect.any(String), name: references[kind].name })
    keys[kind] = item.id
  }
  expect((await get("/api/manage/catalogue/suppliers", manager)).json().items[0])
    .toEqual({ id: keys.suppliers, ...references.suppliers })
  expect((await write(`/api/manage/catalogue/suppliers/${keys.suppliers}`, manager, {
    ...references.suppliers, contact: "تواصل جديد",
  }, "PUT")).statusCode).toBe(204)
  expect((await get("/api/manage/catalogue/suppliers", manager)).json().items[0].contact).toBe("تواصل جديد")

  const payload = { name: "دقيق تجريبي", categoryId: keys.categories, unitId: keys.units,
    supplierId: keys.suppliers, minimumQuantity: 2.5, notes: "ملاحظة المادة" }
  expect((await write("/api/materials", basic, { ...payload, unitId: randomUUID() })).json().error).toBe("invalid_reference")
  expect((await write("/api/materials", basic, { ...payload, minimumQuantity: -1 })).statusCode).toBe(400)
  expect((await write("/api/materials", basic, { ...payload, archived: true })).statusCode).toBe(400)
  expect((await write("/api/materials", basic, payload)).statusCode).toBe(204)
  expect((await write("/api/materials", admin, { ...payload, name: "ملح تجريبي", minimumQuantity: 8 })).statusCode).toBe(204)

  const list = (await get("/api/materials?sort=minimum&direction=desc", basic)).json()
  expect(list.actions).toEqual({ create: true, edit: false, archive: false, overrideSimilarity: false })
  expect(list.items.map((item: { minimumQuantity: number }) => item.minimumQuantity)).toEqual([8, 2.5])
  const { id, code } = list.items[1]
  expect(code).toMatch(/^MAT-[0-9A-F]+$/)
  expect((await get(`/api/materials?search=${code.toLowerCase()}`, basic)).json().total).toBe(1)
  expect((await get(`/api/materials?search=${encodeURIComponent("دقيق")}`, basic)).json().total).toBe(1)
  expect((await get("/api/materials?sort=price", basic)).statusCode).toBe(400)
  expect((await write(`/api/materials/${id}`, basic, payload, "PUT")).statusCode).toBe(404)
  expect((await write(`/api/materials/${id}/archive`, admin, { archived: true }, "PUT")).statusCode).toBe(404)
  expect((await write(`/api/materials/${id}`, manager, { ...payload, name: "دقيق محدّث" }, "PUT")).statusCode).toBe(204)
  expect((await write(`/api/materials/${id}/archive`, manager, { archived: true }, "PUT")).statusCode).toBe(204)
  expect((await get("/api/materials", basic)).json().total).toBe(1)
  const archive = (await get("/api/materials?status=archived", basic)).json()
  expect(archive.items[0]).toMatchObject({ id, code, name: "دقيق محدّث", archived: true, supplierName: references.suppliers.name })
  expect(archive.items[0]).not.toHaveProperty("contact")
  expect((await write(`/api/materials/${id}`, manager, payload, "PUT")).statusCode).toBe(404)
  expect((await write(`/api/materials/${id}/archive`, manager, { archived: false }, "PUT")).statusCode).toBe(204)
  expect((await get("/api/materials", basic)).json().total).toBe(2)
  expect(database.db.select().from(auditLog).all().slice(-3).map((item) => item.action))
    .toEqual(["material_updated", "material_archived", "material_restored"])
})

test("enforces normalized duplicates and confirmation, imports CSV, and preserves merge history", async () => {
  const categoryId = (await get("/api/catalogue/categories", basic)).json().items[0].id
  const unitId = (await get("/api/catalogue/units", basic)).json().items[0].id
  const input = { categoryId, unitId, supplierId: null, minimumQuantity: 0, notes: "", name: "حمض الستريك" }
  expect((await write("/api/materials", basic, input)).statusCode).toBe(204)
  const duplicate = await write("/api/materials", admin, { ...input, name: "حَمْض السِّتريك", confirmSimilarity: true })
  expect(duplicate.statusCode).toBe(409)
  expect(duplicate.json().similarity.level).toBe("exact")
  const sourceId = duplicate.json().similarity.matches[0].id
  expect((await write("/api/materials", basic, { ...input, name: "حامض ستريك" })).json().similarity.level).toBe("warning")
  expect((await write("/api/materials", basic, { ...input, name: "ستريك حمض", confirmSimilarity: true }))
    .json().similarity.level).toBe("high")
  expect((await write("/api/materials", admin, { ...input, name: "ستريك حمض", confirmSimilarity: true })).statusCode).toBe(204)
  const sameName = database.db.select().from(materials).all().find((item) => item.id === sourceId)!
  expect(() => database.db.insert(materials).values({
    ...sameName, id: randomUUID(), code: "MAT-DUPLICATE",
  }).run()).toThrow()

  const csv = "\uFEFFname,category,unit,supplier,minimumQuantity,notes\r\n" +
    'ورق تغليف,مساحيق,كغ,,2.5,"سطر أول\nسطر ثان"\r\n' +
    "حمض الستريك,مساحيق,كغ,,1,\r\n" +
    "عبوة زجاجية,غير موجود,كغ,,1,\r\n" +
    "ورق تغليف,مساحيق,كغ,,3,\r\n"
  const upload = (mode: "preview" | "save", payload = csv) => app.inject({
    method: "POST", url: `/api/materials/import?mode=${mode}`,
    headers: { ...headers, cookie: basic, "content-type": "text/csv" }, payload,
  })
  const before = database.db.select().from(materials).all().length
  expect((await upload("preview")).json()).toMatchObject({ accepted: 1, skipped: 3 })
  expect(database.db.select().from(materials).all()).toHaveLength(before)
  expect((await upload("save")).json()).toMatchObject({ accepted: 1, skipped: 3 })
  expect((await upload("save")).json()).toMatchObject({ accepted: 0, skipped: 4 })
  expect((await upload("preview", "bad,header\n1,2")).statusCode).toBe(400)
  expect((await upload("preview", csv.split("\r\n")[0] + "\r\n" +
    "شمع,مساحيق,كغ,,1,\r\n".repeat(5_001))).statusCode).toBe(400)

  const targetId = (await get("/api/materials?search=" + encodeURIComponent("ستريك حمض"), manager)).json().items[0].id
  expect((await write(`/api/materials/${sourceId}/merge`, admin, { targetId }, "PUT")).statusCode).toBe(404)
  expect((await write(`/api/materials/${sourceId}/merge`, manager, { targetId: sourceId }, "PUT")).statusCode).toBe(409)
  expect((await write(`/api/materials/${sourceId}/merge`, manager, { targetId }, "PUT")).statusCode).toBe(204)
  expect((await write(`/api/materials/${sourceId}/archive`, manager, { archived: false }, "PUT")).statusCode).toBe(409)
  expect((await get(`/api/materials?id=${sourceId}&status=all`, basic)).json().items[0])
    .toMatchObject({ archived: true, mergedIntoId: targetId })
  expect((await get("/api/manage/audit", admin)).statusCode).toBe(404)
  const audit = (await get("/api/manage/audit?search=materials_merged", manager)).json()
  expect(audit.items[0]).toMatchObject({ actorName: accountName, entityId: sourceId, after: { mergedIntoId: targetId } })
  expect(() => database.db.delete(auditLog).run()).toThrow()
})
