import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, expect, test } from "vitest"
import { buildApp } from "../src/app.js"
import { readServerConfig } from "../src/config.js"
import { openDatabase } from "../src/db/database.js"
import { auditLog, branches, categories, materials, stockMovements, units, users } from "../src/db/schema.js"
import { hashPassword } from "../src/modules/auth/passwords.js"
import { ManualProvider } from "../src/modules/shipments/tracking.js"

const origin = "https://rawmat.example.invalid"
const headers = { host: "rawmat.example.invalid", origin }
const password = "shipment browser fixture"
const db = openDatabase(":memory:")
const [sourceId, destinationId, unrelatedId, materialId, unitId, categoryId] = Array.from({ length: 6 }, () => randomUUID())
const cookies = new Map<string, string>()
const path = "/api/shipments"
const trackingNumber = "DUMMY11001"
const shipment = {
  trackingNumber, sourceId, destinationId, dispatchedOn: "2026-11-10",
  items: [{ kind: "material", materialId, quantity: 2.5 }, { kind: "description", description: "حافظة مستندات", quantity: 1 }],
}
let root: string
let app: ReturnType<typeof buildApp>

function get(account: string, url: string) {
  const cookie = cookies.get(account)
  return app.inject({ url, headers: cookie ? { ...headers, cookie } : headers })
}

function post(account: string, url: string, payload: unknown) {
  const cookie = cookies.get(account)
  return app.inject({ method: "POST", url, headers: { ...headers, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    payload: JSON.stringify(payload) })
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "rawmat-shipments-"))
  await mkdir(join(root, "assets"))
  await writeFile(join(root, "index.html"), "<html></html>")
  db.db.insert(branches).values([
    { id: sourceId!, name: "المصدر", city: "مدينة" }, { id: destinationId!, name: "الوجهة", city: "مدينة" },
    { id: unrelatedId!, name: "شعبة أخرى", city: "مدينة" },
  ]).run()
  db.db.insert(units).values({ id: unitId!, name: "كغ" }).run()
  db.db.insert(categories).values({ id: categoryId!, name: "فئة تجريبية" }).run()
  db.db.insert(materials).values({ id: materialId!, code: "MAT-FIXTURE", name: "دقيق", nameNormalized: "دقيق",
    categoryId: categoryId!, unitId: unitId!, minimumQuantity: 0 }).run()
  db.db.insert(stockMovements).values({ id: randomUUID(), branchId: sourceId!, materialId: materialId!, quantity: "5",
    kind: "fixture", referenceId: randomUUID(), referenceItemId: randomUUID(), referenceRevision: 1, occurredAt: 1 }).run()
  const config = readServerConfig({ APP_URL: origin })
  app = buildApp(config.appUrl, root, false, { config, db: db.db, trustProxy: false, now: () => 1_800_000_000_000 })
  const passwordHash = await hashPassword(password)
  for (const [account, branchId] of [["sender", sourceId], ["recipient", destinationId], ["unrelated", unrelatedId]] as const) {
    db.db.insert(users).values({ id: randomUUID(), name: account, loginName: account, role: "user", branchId: branchId!,
      passwordHash, mustChangePassword: false }).run()
    const response = await app.inject({ method: "POST", url: "/api/auth/login", headers, payload: { loginName: account, password } })
    expect(response.statusCode).toBe(200)
    cookies.set(account, String(response.headers["set-cookie"]).split(";")[0]!)
  }
}, 15_000)

afterAll(async () => {
  await app?.close()
  db.close()
  if (root) await rm(root, { recursive: true, force: true })
})

test("registers once, tracks by hand and closes with the quantities confirmed by the receiving branch", async () => {
  expect((await get("signed-out", path)).statusCode).toBe(404)
  expect((await get("sender", "/shipments")).statusCode).toBe(200)
  expect((await post("sender", path, { ...shipment, sourceId: destinationId })).statusCode).toBe(400)
  expect((await post("sender", path, { ...shipment, trackingNumber: "https://example.invalid" })).statusCode).toBe(400)
  expect((await post("sender", path, { ...shipment, items: [{ kind: "material", materialId, quantity: 6 }] })).json())
    .toEqual({ error: "insufficient_stock" })
  const created = await post("sender", path, shipment)
  expect(created.statusCode).toBe(201)
  const { id } = created.json()
  const url = path + "/" + id
  const duplicate = await post("sender", path, { ...shipment, trackingNumber: trackingNumber.toLowerCase() })
  expect(duplicate.statusCode).toBe(200)
  expect(duplicate.json()).toEqual({ id })
  expect((await get("recipient", path + "/tracking/" + trackingNumber)).json()).toEqual({ id })
  const tracked = (await get("sender", url)).json()
  expect(tracked).toMatchObject({ status: "registered", revision: 1, actions: { update: true, receive: false } })
  const itemIds: string[] = tracked.items.map(({ id }: { id: string }) => id)
  const updating = { status: "in_transit", revision: 1, location: "مركز الفرز", description: "غادرت الشعبة" }
  expect((await post("unrelated", url + "/tracking", updating)).statusCode).toBe(404)
  expect((await post("sender", url + "/tracking", updating)).statusCode).toBe(204)
  expect((await post("sender", url + "/tracking", { ...updating, revision: 2, status: "picked_up" })).statusCode).toBe(409)
  expect((await post("sender", url + "/tracking", { ...updating, revision: 2, status: "delivered" })).statusCode).toBe(204)
  expect((await get("recipient", url)).json()).toMatchObject({ status: "delivered", receivedAt: null })
  const receipt = { revision: 3, items: [{ itemId: itemIds[0], quantity: "2.25" }, { itemId: itemIds[1], quantity: "1" }] }
  expect((await post("sender", url + "/receipt", receipt)).statusCode).toBe(404)
  expect((await post("recipient", url + "/receipt", { ...receipt, items: [{ itemId: itemIds[0], quantity: "3" }, receipt.items[1]] })).statusCode).toBe(400)
  expect((await post("recipient", url + "/receipt", receipt)).statusCode).toBe(204)
  expect((await post("recipient", url + "/receipt", receipt)).statusCode).toBe(204)
  expect((await post("recipient", url + "/tracking", { ...updating, revision: 4, status: "exception" })).statusCode).toBe(409)
  const completed = (await get("recipient", url)).json()
  expect(completed).toMatchObject({ status: "delivered", revision: 4, receivedAt: expect.any(Number), actions: { receive: false, update: false } })
  expect(completed.events[0].description).toBe("تأكّد الاستلام في الوجهة")
  expect(completed.items.map(({ receivedQuantity }: { receivedQuantity: string }) => receivedQuantity)).toEqual(["2.25", "1"])
  const balance = (await get("recipient", "/api/materials/" + materialId + "/stock")).json()
  expect(balance.items).toEqual(expect.arrayContaining([
    { branchId: sourceId, branchName: "المصدر", quantity: "2.5" },
    { branchId: destinationId, branchName: "الوجهة", quantity: "2.25" },
  ]))
  expect(db.db.select().from(stockMovements).all().filter(({ referenceId }) => referenceId === id)).toHaveLength(2)
  expect(db.db.select().from(auditLog).all().filter(({ entityId }) => entityId === id).map(({ action }) => action))
    .toEqual(["shipment_created", "shipment_tracking_updated", "shipment_tracking_updated", "shipment_received"])
  const list = (await get("unrelated", path + "?status=delivered&search=dummy110")).json()
  expect(list.items).toHaveLength(1)
})

test("confirms returned contents at the source and uses a network-free tracking adapter", async () => {
  const response = await post("sender", path, {
    ...shipment, trackingNumber: "DUMMY22002", items: [{ kind: "material", materialId, quantity: 1 }],
  })
  expect(response.statusCode).toBe(201)
  const url = path + "/" + response.json().id
  expect((await post("sender", url + "/tracking", {
    revision: 1, status: "returned", location: "", description: "أعادها الناقل",
  })).statusCode).toBe(204)
  const row = (await get("sender", url)).json()
  const input = { revision: 2, items: [{ itemId: row.items[0].id, quantity: "1" }] }
  expect((await post("recipient", url + "/receipt", input)).statusCode).toBe(404)
  expect((await post("sender", url + "/receipt", input)).statusCode).toBe(204)
  expect((await get("sender", url)).json()).toMatchObject({ status: "returned", receivedAt: expect.any(Number) })
  expect(await new ManualProvider().track(["DUMMY22002"])).toEqual([{ awb: "DUMMY22002", events: [] }])
})
