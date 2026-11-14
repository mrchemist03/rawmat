import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, expect, test } from "vitest"
import { buildApp } from "../src/app.js"
import { readServerConfig } from "../src/config.js"
import { openDatabase } from "../src/db/database.js"
import { auditLog, branches, categories, materialCosts, materials, purchaseItemCosts, stockMovements, units, users } from "../src/db/schema.js"
import { hashPassword } from "../src/modules/auth/passwords.js"

const origin = "https://rawmat.example.invalid"
const headers = { host: "rawmat.example.invalid", origin }
const password = "purchase fixture password"
const db = openDatabase(":memory:")
let root: string
let app: ReturnType<typeof buildApp>
const cookies = new Map<string, string>()
const ids = {
  branch: randomUUID(), inactiveBranch: randomUUID(), material: randomUUID(), secondMaterial: randomUUID(),
  category: randomUUID(), unit: randomUUID(),
}
const draft = {
  branchId: ids.branch, neededOn: "2026-12-01", supplierId: null, notes: "ملاحظات للاختبار",
  items: [{ materialId: ids.material, quantity: 2.5 }, { materialId: ids.secondMaterial, quantity: 3 }],
}
const endpoint = "/api/purchases"

function fetchAs(login: string, url: string) {
  const cookie = cookies.get(login)
  return app.inject({ url, headers: cookie ? { ...headers, cookie } : headers })
}

function write(login: string, url: string, payload: Record<string, unknown>, method: "POST" | "PUT" = "POST") {
  const cookie = cookies.get(login)
  return app.inject({ method, url, headers: cookie ? { ...headers, cookie } : headers, payload })
}

async function create() {
  const response = await write("owner", endpoint, draft)
  expect(response.statusCode).toBe(201)
  const id = response.json().id as string
  expect(response.headers.location).toBe(endpoint + "/" + id)
  return endpoint + "/" + id
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "rawmat-purchases-"))
  await mkdir(join(root, "assets"))
  await writeFile(join(root, "index.html"), "<html></html>")
  const { category, unit, material, secondMaterial, branch, inactiveBranch } = ids
  db.db.insert(branches).values([
    { id: branch, name: "شعبة الطلب", city: "مدينة" },
    { id: inactiveBranch, name: "شعبة موقوفة", city: "مدينة", active: false },
  ]).run()
  db.db.insert(categories).values({ id: category, name: "فئة تجريبية" }).run()
  db.db.insert(units).values({ id: unit, name: "كغ" }).run()
  db.db.insert(materials).values([
    { id: material, code: "MAT-ONE", name: "مادة أولى", nameNormalized: "ماده اولي", categoryId: category, unitId: unit, minimumQuantity: 0 },
    { id: secondMaterial, code: "MAT-TWO", name: "مادة ثانية", nameNormalized: "ماده ثانيه", categoryId: category, unitId: unit, minimumQuantity: 0 },
  ]).run()
  const settings = readServerConfig({ APP_URL: origin })
  app = buildApp(settings.appUrl, root, false, { config: settings, db: db.db, trustProxy: false })
  const passwordHash = await hashPassword(password)
  for (const [login, role, pending] of [
    ["owner", "user", false], ["other", "admin", false], ["manager", "superuser", false], ["pending", "user", true],
  ] as const) {
    const loginName = `test.${login}`
    db.db.insert(users).values({ id: randomUUID(), name: login, loginName, role, passwordHash, mustChangePassword: pending }).run()
    const response = await app.inject({ method: "POST", url: "/api/auth/login", headers, payload: { loginName, password } })
    expect(response.statusCode).toBe(200)
    cookies.set(login, String(response.headers["set-cookie"]).split(";")[0]!)
  }
}, 15_000)

afterAll(async () => {
  await app?.close()
  db.close()
  if (root) await rm(root, { recursive: true, force: true })
})

test("creates, edits and submits a draft without exposing role or price fields", async () => {
  const url = await create()
  const initial = (await fetchAs("owner", url)).json()
  expect(initial).toMatchObject({ status: "draft", revision: 1, actions: { edit: true, submit: true } })
  expect(initial.items.map(({ quantity }: { quantity: number }) => quantity)).toEqual([2.5, 3])
  expect((await fetchAs("other", url)).json().actions).toEqual({ edit: false, submit: false })
  expect((await write("other", url, { ...draft, revision: 1 }, "PUT")).statusCode).toBe(404)
  expect((await write("other", url + "/transition", { status: "submitted", revision: 1 })).statusCode).toBe(404)
  expect((await write("manager", url, { ...draft, revision: 1, notes: "تعديل" }, "PUT")).statusCode).toBe(204)
  expect((await write("owner", url, { ...draft, revision: 1 }, "PUT")).json()).toEqual({ error: "stale_purchase" })
  expect((await write("owner", url + "/transition", { status: "submitted", revision: 1 })).json()).toEqual({ error: "stale_purchase" })
  for (const status of ["received", "approved", "ordered", "cancelled"]) {
    expect((await write("owner", url + "/transition", { status, revision: 2 })).statusCode).toBe(409)
  }
  const submit = { status: "submitted", revision: 2 }
  expect((await write("owner", url + "/transition", submit)).statusCode).toBe(204)
  expect((await write("owner", url + "/transition", submit)).statusCode).toBe(204)
  expect((await write("owner", url, { ...draft, revision: 3 }, "PUT")).statusCode).toBe(409)
  const detail = (await fetchAs("owner", url)).json()
  expect(detail).toMatchObject({ status: "submitted", revision: 3, notes: "تعديل", actions: { edit: false, submit: false } })
  expect(JSON.stringify(detail)).not.toMatch(/cost|price|currency|password|role/i)
  const list = (await fetchAs("other", endpoint + "?status=submitted&search=" + initial.number)).json()
  expect(list.total).toBe(1)
  expect(list.items[0]).toMatchObject({ status: "submitted", requesterName: "owner" })
  const events = db.db.select().from(auditLog).where(eq(auditLog.entityId, initial.id)).all()
  expect(events.map(({ action }) => action)).toEqual(["purchase_created", "purchase_updated", "purchase_submitted"])
})

test("validates scope, references, signs of quantities and strict mutation fields", async () => {
  expect((await fetchAs("signed-out", endpoint)).statusCode).toBe(404)
  expect((await fetchAs("pending", endpoint)).statusCode).toBe(404)
  expect((await fetchAs("owner", "/purchases")).statusCode).toBe(200)
  expect((await fetchAs("owner", endpoint + "/branches")).json().items).toEqual([{ id: ids.branch, name: "شعبة الطلب" }])
  for (const payload of [
    { ...draft, status: "submitted" }, { ...draft, price: 4 }, { ...draft, neededOn: "2026-02-30" },
    { ...draft, items: [] }, { ...draft, items: [draft.items[0], draft.items[0]] },
    { ...draft, items: [{ materialId: ids.material, quantity: 0 }] },
    { ...draft, branchId: ids.inactiveBranch }, { ...draft, supplierId: randomUUID() },
    { ...draft, items: [{ materialId: randomUUID(), quantity: 1 }] },
  ]) expect((await write("owner", endpoint, payload)).statusCode).toBe(400)
  const url = await create()
  try {
    db.db.update(materials).set({ archived: true }).where(eq(materials.id, ids.material)).run()
    expect((await write("owner", url + "/transition", { status: "submitted", revision: 1 })).json())
      .toEqual({ error: "invalid_purchase_reference" })
    expect((await fetchAs("owner", url)).json().status).toBe("draft")
  } finally {
    db.db.update(materials).set({ archived: false }).where(eq(materials.id, ids.material)).run()
  }
})

test("isolates exact monetary values and records partial and complete receipts atomically", async () => {
  const url = await create()
  const id = url.split("/").at(-1)!
  const draftDetail = (await fetchAs("owner", url)).json()
  const [first, second] = draftDetail.items
  const priceRows = [
    { itemId: first.id, currency: "TRY", unitPriceMinor: 12345 },
    { itemId: second.id, currency: "USD", unitPriceMinor: 67890 },
  ]
  const decision = (actor: string, payload: Record<string, unknown>) => write(actor, url + "/decision", payload)
  const receipt = (actor: string, revision: number, items: { itemId: string; quantity: string | number }[]) =>
    write(actor, url + "/receipts", { revision, items })
  expect((await write("owner", url + "/transition", { revision: 1, status: "submitted" })).statusCode).toBe(204)
  expect((await decision("owner", { revision: 2, status: "approved", prices: priceRows })).statusCode).toBe(404)
  expect((await decision("other", { revision: 2, status: "ordered" })).statusCode).toBe(409)
  expect((await decision("other", { revision: 2, status: "rejected", reason: " " })).statusCode).toBe(400)
  expect((await decision("other", { revision: 2, status: "approved", prices: [priceRows[0]] })).statusCode).toBe(400)
  expect(db.db.select().from(purchaseItemCosts).all()).toHaveLength(0)
  expect((await decision("other", { revision: 2, status: "approved" })).statusCode).toBe(204)
  expect((await decision("other", { revision: 3, status: "ordered" })).json()).toEqual({ error: "prices_required" })
  expect((await decision("other", { revision: 3, status: "ordered", prices: priceRows })).statusCode).toBe(204)
  for (const actor of ["other", "manager"]) {
    const result = await fetchAs(actor, url + "/costs")
    expect(result.statusCode).toBe(200)
    expect(result.json().totals).toEqual([
      { currency: "TRY", totalMinor: "30863" }, { currency: "USD", totalMinor: "203670" },
    ])
  }
  const averages = db.db.select().from(materialCosts).all()
  expect(averages.find(({ materialId }) => materialId === ids.material)).toMatchObject({
    currency: "TRY", averageUnitPriceMinor: 12345, lastUnitPriceMinor: 12345,
  })

  const excessive = [{ itemId: first.id, quantity: 0.1 }, { itemId: second.id, quantity: 4 }]
  expect((await receipt("owner", 4, excessive)).json()).toEqual({ error: "invalid_receipt" })
  expect(db.db.select().from(stockMovements).all()).toHaveLength(0)
  const partial = [{ itemId: first.id, quantity: 0.1 }]
  expect((await receipt("owner", 4, partial)).statusCode).toBe(204)
  expect((await receipt("owner", 4, partial)).statusCode).toBe(204)
  expect((await receipt("owner", 4, [{ itemId: first.id, quantity: 0.2 }])).statusCode).toBe(409)
  expect((await fetchAs("owner", url)).json()).toMatchObject({ status: "partially_received", revision: 5 })
  expect((await decision("other", { revision: 5, status: "cancelled", reason: "اختبار" })).statusCode).toBe(409)
  expect((await receipt("owner", 5, [{ itemId: first.id, quantity: "0.200000000000000001" }])).statusCode).toBe(204)
  const ready = (await fetchAs("owner", url)).json()
  expect(ready.items[0].remainingExact).toBe("2.199999999999999999")
  expect((await receipt("owner", 6, [
    { itemId: first.id, quantity: ready.items[0].remainingExact }, { itemId: second.id, quantity: "3" },
  ])).statusCode).toBe(204)
  expect((await fetchAs("owner", url)).json()).toMatchObject({ status: "received", revision: 7 })
  expect(db.db.select().from(stockMovements).all()).toHaveLength(4)
  expect(() => db.db.delete(stockMovements).run()).toThrow()
  const stock = "/api/materials/" + ids.material + "/stock"
  expect((await fetchAs("owner", stock)).json()).toEqual({
    items: [{ branchId: ids.branch, branchName: "شعبة الطلب", quantity: "2.5" }], total: 1,
  })

  const ordinaryResponses = await Promise.all([
    fetchAs("owner", "/api/me"), fetchAs("owner", "/api/auth/session"), fetchAs("owner", "/api/auth/config"),
    fetchAs("owner", "/api/materials"), fetchAs("owner", "/api/materials/similarity?name=test&unitId=" + ids.unit),
    fetchAs("owner", "/api/catalogue/categories"), fetchAs("owner", "/api/catalogue/units"), fetchAs("owner", "/api/catalogue/suppliers"),
    fetchAs("owner", endpoint + "/branches"), fetchAs("owner", endpoint), fetchAs("owner", url), fetchAs("owner", stock),
    fetchAs("owner", url + "/costs"), fetchAs("owner", "/api/manage/audit"),
    fetchAs("owner", "/api/manage/accounts"), fetchAs("owner", "/api/manage/branches"),
    fetchAs("owner", "/api/manage/catalogue/suppliers"), fetchAs("owner", "/healthz"),
    fetchAs("owner", endpoint + "?sort=unitPriceMinor"), decision("owner", { revision: 2, status: "approved", prices: priceRows }),
  ])
  for (const response of ordinaryResponses) {
    expect([200, 400, 404]).toContain(response.statusCode)
    expect(response.body).not.toMatch(/"(?:[^"]*(?:cost|price|currency)[^"]*|totals|totalMinor)"\s*:/i)
    expect(response.body).not.toMatch(/:\s*"?(?:12345|67890|30863|203670)"?(?:[,}\]])/)
  }
  expect((await fetchAs("owner", url + "/costs")).statusCode).toBe(404)
  expect((await fetchAs("owner", endpoint + "?sort=unitPriceMinor")).statusCode).toBe(400)
  const entries = db.db.select().from(auditLog).where(eq(auditLog.entityId, id)).all()
  expect(entries.filter(({ action }) => action === "purchase_receipt")).toHaveLength(3)
  expect(JSON.stringify(entries)).not.toMatch(/unitPriceMinor|12345|67890/)
})

test("requires a rejection reason and prevents further transitions after rejection or cancellation", async () => {
  const rejected = await create()
  await write("owner", rejected + "/transition", { revision: 1, status: "submitted" })
  expect((await write("manager", rejected + "/decision", { revision: 2, status: "rejected", reason: "طلب مكرر" })).statusCode).toBe(204)
  expect((await fetchAs("owner", rejected)).json()).toMatchObject({ status: "rejected", decisionReason: "طلب مكرر" })
  expect((await write("manager", rejected + "/decision", { revision: 3, status: "approved" })).statusCode).toBe(409)
  const cancelled = await create()
  await write("owner", cancelled + "/transition", { revision: 1, status: "submitted" })
  expect((await write("manager", cancelled + "/decision", { revision: 2, status: "cancelled", reason: "انتهت الحاجة" })).statusCode).toBe(204)
  expect((await fetchAs("owner", cancelled)).json()).toMatchObject({ status: "cancelled", decisionReason: "انتهت الحاجة" })
})
