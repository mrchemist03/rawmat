import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "csv-parse/sync"
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, expect, test } from "vitest"
import { buildApp } from "../src/app.js"
import { readServerConfig } from "../src/config.js"
import { openDatabase } from "../src/db/database.js"
import { auditLog, branches, categories, materials, purchaseItemCosts, purchaseRequestItems, purchaseRequests,
  shipments, stockMovements, trackingEvents, units, users } from "../src/db/schema.js"
import { hashPassword } from "../src/modules/auth/passwords.js"

const origin = "https://overview.example.invalid"
const headers = { host: "overview.example.invalid", origin }
const password = "overview fixture password"
const time = (value: string) => Date.parse(value)
const now = time("2026-11-17T12:00:00Z")
const storage = openDatabase(":memory:")
const { db } = storage
const ids = { basic: randomUUID(), admin: randomUUID(), manager: randomUUID(), source: randomUUID(),
  destination: randomUUID(), inactive: randomUUID(), category: randomUUID(), unit: randomUUID(), material: randomUUID(),
  sourceMaterial: randomUUID(), secondMaterial: randomUUID() }
const cookies = new Map<string, string>()
let app: ReturnType<typeof buildApp>
let root: string

function get(path: string, login?: string) {
  return app.inject({ url: path, headers: login ? { ...headers, cookie: cookies.get(login)! } : headers })
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "rawmat-overview-"))
  await mkdir(join(root, "assets"))
  await writeFile(join(root, "index.html"), "<html></html>")
  const config = readServerConfig({ APP_URL: origin })
  app = buildApp(config.appUrl, root, false, { config, db, trustProxy: false, now: () => now })
  const passwordHash = await hashPassword(password)
  for (const [role, key] of [["user", "basic"], ["admin", "admin"], ["superuser", "manager"]] as const) {
    db.insert(users).values({ id: ids[key], role, loginName: key, name: key + " fixture", passwordHash, mustChangePassword: false }).run()
    const reply = await app.inject({ method: "POST", url: "/api/auth/login", headers, payload: { loginName: key, password } })
    expect(reply.statusCode).toBe(200)
    cookies.set(key, String(reply.headers["set-cookie"]).split(";")[0]!)
  }
  db.insert(branches).values([
    { id: ids.source, name: "Source fixture", city: "Test" }, { id: ids.destination, name: "Destination fixture", city: "Test" },
    { id: ids.inactive, name: "Inactive fixture", city: "Test", active: false },
  ]).run()
  db.insert(categories).values({ id: ids.category, name: "Category fixture" }).run()
  db.insert(units).values({ id: ids.unit, name: "Unit fixture" }).run()
  const material = { categoryId: ids.category, unitId: ids.unit }
  db.insert(materials).values([
    { ...material, id: ids.material, name: "Main fixture", code: "ACTIVE-01", minimumQuantity: 1,
      notes: '  =SUM(1,2),"fixture"' },
    { ...material, id: ids.sourceMaterial, name: "Merged fixture", code: "ARCHIVED-01", minimumQuantity: 10, archived: true, mergedIntoId: ids.material },
    { ...material, id: ids.secondMaterial, name: "Second fixture", code: "ACTIVE-02", minimumQuantity: 1 },
  ]).run()
  for (const [branchId, materialId, quantity] of [[ids.source, ids.material, "0.7"],
    [ids.destination, ids.sourceMaterial, "0.3"], [ids.inactive, ids.secondMaterial, "5"]] as const) {
    db.insert(stockMovements).values({ id: randomUUID(), branchId, materialId, quantity, kind: "fixture",
      referenceId: randomUUID(), referenceItemId: randomUUID(), referenceRevision: 1, occurredAt: now }).run()
  }
  for (const [number, status, orderedAt] of [
    ["PR-WAIT", "submitted", null], ["PR-DRAFT", "draft", null], ["PR-THIS", "ordered", time("2026-11-01T00:00:00Z")],
    ["PR-OLD", "received", time("2026-10-31T23:59:59Z")], ["PR-NOT-ORDERED", "approved", null],
  ] as const) {
    const id = randomUUID()
    db.insert(purchaseRequests).values({ id, number, status, orderedAt, createdAt: now,
      requestedBy: ids.basic, branchId: ids.source, neededOn: status === "ordered" ? "2026-11-17" : "2026-11-16" }).run()
    for (const [position, materialId, quantity, currency] of [[0, ids.sourceMaterial, 2.5, "TRY"], [1, ids.secondMaterial, 3, "USD"]] as const) {
      const itemId = randomUUID()
      db.insert(purchaseRequestItems).values({ id: itemId, requestId: id, materialId, position, quantity }).run()
      db.insert(purchaseItemCosts).values({ itemId, unitPriceMinor: status === "ordered" ? 101 : 919191, currency }).run()
    }
  }
  for (const [trackingNumber, status, dispatchedOn, eventAt] of [
    ["FIXTURE101", "delivered", "2026-11-10", time("2026-11-12T19:00:00Z")],
    ["FIXTURE102", "delivered", "2026-11-10", time("2026-11-14T02:00:00Z")],
    ["FIXTURE103", "in_transit", "2026-11-10", time("2026-11-14T12:00:00Z")],
    ["FIXTURE104", "returned", "2026-11-10", time("2026-11-11T00:00:00Z")],
    ["FIXTURE105", "delivered", "2026-10-30", time("2026-10-31T23:59:59Z")],
    ["FIXTURE106", "out_for_delivery", "2026-11-10", time("2026-11-17T00:00:00Z")],
  ] as const) {
    const id = randomUUID()
    db.insert(shipments).values({ id, trackingNumber, status, dispatchedOn, trackingChangedAt: eventAt,
      createdAt: time(dispatchedOn), sourceId: ids.source, destinationId: ids.destination, createdBy: ids.basic }).run()
    db.insert(trackingEvents).values({ id: randomUUID(), shipmentId: id, status, occurredAt: eventAt,
      code: "fixture", description: "Fixture event", location: "Fixture", revision: 1, source: "manual" }).run()
    if (status === "delivered") db.insert(trackingEvents).values({ id: randomUUID(), shipmentId: id, status, occurredAt: eventAt + 3_600_000,
      code: "receipt-fixture", description: "Receipt fixture", revision: 2, source: "manual" }).run()
  }
  db.insert(auditLog).values([
    { id: randomUUID(), actorId: ids.manager, entityId: "purchase.submitted", entity: "notification_rule",
      action: "notification_rule_saved", occurredAt: now, after: { enabled: true } },
    { id: randomUUID(), actorId: ids.basic, entityId: ids.material, entity: "material",
      action: "material_updated", occurredAt: now - 1000, after: { name: "fixture internal detail" } },
  ]).run()
}, 15_000)

afterAll(async () => {
  await app?.close()
  storage.close()
  if (root) await rm(root, { recursive: true, force: true })
})

test("computes operational totals for all accounts and isolates monthly spending by role and currency", async () => {
  expect((await get("/api/overview")).statusCode).toBe(404)
  const result = await get("/api/overview", "basic")
  expect(result.statusCode).toBe(200)
  expect(result.json()).toMatchObject({
    month: "2026-11", purchases: { statuses: { draft: 1, submitted: 1, ordered: 1, approved: 1, received: 1 }, overdue: 2 },
    lowStock: 1, shipments: { inTransit: 2, overdue: 1, deliveredThisMonth: 2,
      routes: [{ sourceId: ids.source, destinationId: ids.destination, count: 3, averageDays: 7 / 3 }] },
    activity: [{ action: "material_updated" }],
  })
  expect(result.json()).not.toHaveProperty("spending")
  expect(result.body).not.toContain("fixture internal detail")
  for (const account of ["admin", "manager"]) {
    const elevated = (await get("/api/overview", account)).json()
    expect(elevated.spending).toEqual([
      { currency: "TRY", totalMinor: "253", materials: [{ id: ids.material, name: "Main fixture", amountMinor: "253" }] },
      { currency: "USD", totalMinor: "303", materials: [{ id: ids.secondMaterial, name: "Second fixture", amountMinor: "303" }] },
    ])
  }
})

test("exports the matching rows with formula cells neutralized and checks audit permission on every entry point", async () => {
  const overview = await get("/api/overview/export", "admin")
  expect(overview.headers).toMatchObject({ "content-type": "text/csv; charset=utf-8", "cache-control": "no-store",
    "content-disposition": 'attachment; filename="overview.csv"' })
  expect(overview.body).toContain('"2.53","TRY"')
  expect((await get("/api/overview/export?spending=true", "basic")).statusCode).toBe(400)
  const basic = await get("/api/overview/export", "basic")
  expect(basic.body).not.toMatch(/TRY|USD|إنفاق/)
  const materialsCsv = await get("/api/materials/export?search=ACTIVE-01&status=active&page=2", "basic")
  const rows = parse(materialsCsv.body, { bom: true })
  expect(rows).toHaveLength(2)
  expect(rows[1]).toContain("'  =SUM(1,2),\"fixture\"")
  const purchaseCsv = await get("/api/purchases/export?status=submitted", "basic")
  expect(purchaseCsv.body).toContain("PR-WAIT")
  expect(purchaseCsv.body).not.toMatch(/PR-THIS|price|cost|919191/i)
  expect((await get("/api/shipments/export?status=in_transit", "basic")).body).toContain("FIXTURE103")
  expect((await get("/api/manage/audit/export", "admin")).statusCode).toBe(404)
  expect((await get("/api/manage/audit/export", "basic")).statusCode).toBe(404)
  const audit = await get("/api/manage/audit?entity=notification_rule&from=2026-11-17&to=2026-11-17", "manager")
  expect(audit.json()).toMatchObject({ total: 1, items: [{ entityId: "purchase.submitted", action: "notification_rule_saved" }] })
  expect((await get("/api/manage/audit/export?search=manager", "manager")).body).toContain("purchase.submitted")
})

test("the ordinary account reads the overview and CSV even when the cost table is unavailable", async () => {
  db.run(sql.raw("drop table purchase_item_costs"))
  expect((await get("/api/overview", "basic")).statusCode).toBe(200)
  expect((await get("/api/overview/export", "basic")).statusCode).toBe(200)
})

test("limits repeated overview calculations without consuming the export quota", async () => {
  db.run(sql`DELETE FROM login_attempts`)
  for (let count = 0; count < 60; count++) {
    expect((await get("/api/overview", "basic")).statusCode).toBe(200)
  }
  const limited = await get("/api/overview", "basic")
  expect(limited.statusCode).toBe(429)
  expect(limited.headers["retry-after"]).toBe("60")
  expect((await get("/api/overview/export", "basic")).statusCode).toBe(200)
})
