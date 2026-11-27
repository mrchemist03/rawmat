import { randomUUID } from "node:crypto"
import { parse } from "csv-parse/sync"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { buildApp } from "../src/app.js"
import { readServerConfig } from "../src/config.js"
import { openDatabase } from "../src/db/database.js"
import { auditLog, branches, categories, materials, notificationOutbox, stockMovements, units, users } from "../src/db/schema.js"
import { hashPassword } from "../src/modules/auth/passwords.js"
import { ManualProvider } from "../src/modules/shipments/tracking.js"
import { createShipmentRepository } from "../src/modules/shipments/repository.js"

const origin = "https://rawmat.example.invalid"
const config = readServerConfig({ APP_URL: origin })
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

function post(account: string, url: string, payload: unknown, method: "POST" | "PUT" = "POST") {
  const cookie = cookies.get(account)
  return app.inject({ method, url, headers: { ...headers, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
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
  app = buildApp(config.appUrl, root, false, { config, db: db.db, trustProxy: false, now: () => 1_800_000_000_000 })
  const passwordHash = await hashPassword(password)
  for (const [account, branchId, role] of [["sender", sourceId, "user"], ["recipient", destinationId, "user"],
    ["unrelated", unrelatedId, "user"], ["administrator", null, "admin"], ["manager", null, "superuser"]] as const) {
    db.db.insert(users).values({ id: randomUUID(), name: account, loginName: account, role, branchId: branchId ?? null,
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
  expect(tracked.tracking).toBeNull()
  expect((await post("sender", url + "/refresh", {})).statusCode).toBe(404)
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

test("queues a provider refresh through the authenticated API while shipment registration stays independent", async () => {
  const awb = "SYNTHETIC33"
  const now = 1_800_000_000_000
  const track = vi.fn(async (numbers: string[]) => numbers.map((number) => ({ awb: number, events: [] })))
  const auto = buildApp(config.appUrl, root, false, { config, db: db.db, trustProxy: false, now: () => now,
    shipmentTracking: { provider: { track } } })
  const request = (account: string, url: string, payload?: object) => auto.inject({ url,
    method: payload ? "POST" : "GET", headers: { ...headers, cookie: cookies.get(account) ?? "" }, payload })
  try {
    const created = await request("sender", path, { ...shipment, trackingNumber: awb,
      items: [{ kind: "description", description: "Fixture", quantity: 1 }] })
    expect(created.statusCode).toBe(201)
    const url = path + "/" + created.json().id
    await vi.waitFor(async () => {
      expect((await request("sender", url)).json().tracking).toEqual({ state: "idle", lastPolledAt: now })
    })
    expect((await request("unrelated", url + "/refresh", {})).statusCode).toBe(404)
    expect((await request("sender", url + "/refresh", {})).statusCode).toBe(202)
    const limited = await request("recipient", url + "/refresh", {})
    expect(limited.statusCode).toBe(429)
    expect(limited.headers["retry-after"]).toBe("120")
    await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(2))
  } finally {
    await auto.close()
  }
})

test("only a superuser can correct an unreceived shipment, with atomic stock and tracking changes", async () => {
  const input = { ...shipment, trackingNumber: "DUMMY44004",
    items: [{ kind: "material", materialId, quantity: 1 }, { kind: "description", description: "Fixture", quantity: 1 }] }
  const created = await post("sender", path, input)
  expect(created.statusCode).toBe(201)
  const { id } = created.json()
  const url = path + "/" + id
  const edit = (account: string, payload: unknown) => post(account, url, payload, "PUT")
  for (const account of ["sender", "administrator"]) {
    expect((await get(account, url)).json().edit).toBeNull()
    expect((await edit(account, { ...input, revision: 1 })).statusCode).toBe(404)
  }
  expect((await edit("signed-out", { ...input, revision: 1 })).statusCode).toBe(404)
  expect((await get("manager", url)).json().edit).toEqual({ sourceId, destinationId, materialIds: [materialId, null] })
  expect((await post("sender", url + "/tracking", { revision: 1, status: "delivered", location: "",
    description: "Fixture before correction" })).statusCode).toBe(204)

  const moved = { ...input, sourceId: unrelatedId, revision: 2, dispatchedOn: "2026-11-11",
    items: [{ kind: "material", materialId, quantity: 3 }, { kind: "description", description: "Revised fixture", quantity: 2 }] }
  expect((await edit("manager", { ...moved, trackingNumber })).json()).toEqual({ error: "duplicate_tracking_number" })
  expect((await edit("manager", moved)).json()).toEqual({ error: "insufficient_stock" })
  expect((await get("manager", url)).json()).toMatchObject({ revision: 2, sourceName: "المصدر" })
  expect(db.db.select().from(stockMovements).all().filter(({ referenceId }) => referenceId === id)).toHaveLength(1)
  db.db.insert(stockMovements).values({ id: randomUUID(), branchId: unrelatedId!, materialId: materialId!, quantity: "4",
    kind: "fixture", referenceId: randomUUID(), referenceItemId: randomUUID(), referenceRevision: 1, occurredAt: 1 }).run()
  expect((await edit("manager", moved)).statusCode).toBe(204)
  expect((await edit("manager", moved)).json()).toEqual({ error: "stale_shipment" })
  const corrected = (await get("manager", url)).json()
  expect(corrected).toMatchObject({ revision: 3, sourceName: "شعبة أخرى", status: "delivered",
    lastEvent: { description: "Fixture before correction" }, items: [{ quantity: "3" }, { quantity: "2" }] })
  expect(db.db.select().from(stockMovements).all().filter(({ referenceId }) => referenceId === id)
    .map(({ branchId, quantity }) => [branchId, quantity])).toEqual([[sourceId, "-1"], [sourceId, "1"], [unrelatedId, "-3"]])

  const number = "DUMMY44005"
  const oldNotice = randomUUID()
  db.db.insert(notificationOutbox).values({ id: oldNotice, event: "shipment.delivered", dedupeKey: "shipment.delivered:" + id + ":2",
    occurredAt: 1, nextAttemptAt: 1, message: "Fixture notice", data: { awb: input.trackingNumber }, recipients: [] }).run()
  expect((await edit("manager", { ...moved, revision: 3, trackingNumber: number })).statusCode).toBe(204)
  expect(db.db.select().from(notificationOutbox).all().some(({ id }) => id === oldNotice)).toBe(false)
  expect((await get("manager", path + "/tracking/" + input.trackingNumber)).statusCode).toBe(404)
  expect((await get("manager", path + "/tracking/" + number)).json()).toEqual({ id })
  const reset = (await get("manager", url)).json()
  expect(reset).toMatchObject({ status: "registered", revision: 4, lastEvent: { description: "صُحّح رقم التتبع" },
    events: [{ status: "registered" }] })
  expect((await post("recipient", url + "/receipt", { revision: 4,
    items: reset.items.map((item: { id: string; quantity: string }) => ({ itemId: item.id, quantity: item.quantity })),
  })).statusCode).toBe(204)
  expect((await get("manager", url)).json().edit).toBeNull()
  expect((await edit("manager", { ...moved, revision: 5, trackingNumber: number })).json()).toEqual({ error: "shipment_closed" })
  const audits = db.db.select().from(auditLog).all().filter(({ entityId, action }) => entityId === id && action === "shipment_edited")
  expect(audits).toHaveLength(2)
  expect(audits[1]?.before?.trackingNumber).toBe(input.trackingNumber)
  expect(audits[1]?.after?.trackingNumber).toBe(number)
})

test("lists and exports ordered shipment contents, preserves decimals and CSV escaping, and reflects edits", async () => {
  const material = randomUUID()
  const name = 'حمض "الستريك"، تجريبي'
  db.db.insert(materials).values({ id: material, code: "MAT-CONTENTS", name, nameNormalized: "ماده اختبار المحتويات",
    categoryId: categoryId!, unitId: unitId!, minimumQuantity: 0 }).run()
  db.db.insert(stockMovements).values({ id: randomUUID(), branchId: sourceId!, materialId: material, quantity: "10",
    kind: "fixture", referenceId: randomUUID(), referenceItemId: randomUUID(), referenceRevision: 1, occurredAt: 1 }).run()
  const input = { ...shipment, trackingNumber: "CONTENTS001", items: [
    { kind: "description", description: "=SUM(1,2)", quantity: 1 },
    { kind: "material", materialId: material, quantity: 2.5 },
    { kind: "description", description: 'مستندات، "نسخة"\nسطر ثانٍ', quantity: 0.125 },
  ] }
  const created = await post("sender", path, input)
  expect(created.statusCode).toBe(201)
  const list = (await get("sender", path + "?search=CONTENTS001")).json()
  expect(list.items).toHaveLength(1)
  expect(list.items[0].contents).toEqual([
    { name: "=SUM(1,2)", quantity: "1", unitName: null },
    { name, quantity: "2.5", unitName: "كغ" },
    { name: 'مستندات، "نسخة"\nسطر ثانٍ', quantity: "0.125", unitName: null },
  ])
  expect(Object.keys(list.items[0].contents[1]).sort()).toEqual(["name", "quantity", "unitName"])
  expect((await get("signed-out", path + "/export?search=CONTENTS001")).statusCode).toBe(404)
  const csv = await get("sender", path + "/export?search=CONTENTS001")
  expect(csv.statusCode).toBe(200)
  const records = parse(csv.body, { columns: true, bom: true })
  expect(records).toHaveLength(1)
  expect(records[0]["محتويات الشحنة"]).toBe("'=SUM(1,2) × 1\n" + name + ' × 2.5 كغ\nمستندات، "نسخة"\nسطر ثانٍ × 0.125')
  const edited = await post("manager", path + "/" + created.json().id, { ...input, revision: 1, items: [
    { kind: "material", materialId: material, quantity: 0.75 },
    { kind: "description", description: "مستندات مصححة", quantity: 2 },
  ] }, "PUT")
  expect(edited.statusCode).toBe(204)
  const updated = (await get("sender", path + "?search=CONTENTS001")).json().items[0]
  expect(updated.contents).toEqual([{ name, quantity: "0.75", unitName: "كغ" }, { name: "مستندات مصححة", quantity: "2", unitName: null }])
  const updatedCsv = await get("sender", path + "/export?search=CONTENTS001")
  expect(parse(updatedCsv.body, { columns: true, bom: true })[0]["محتويات الشحنة"])
    .toBe(name + " × 0.75 كغ\nمستندات مصححة × 2")
})

test("keeps paginated shipment contents isolated and exports all rows across content batches", async () => {
  const sender = db.db.select().from(users).all().find(({ loginName }) => loginName === "sender")!
  const repo = createShipmentRepository(db.db, () => 1_800_000_000_000)
  const expected = new Map<string, string>()
  for (let index = 0; index < 501; index++) {
    const trackingNumber = "BULKCONT" + String(index).padStart(4, "0")
    const description = "محتوى تجريبي " + index
    const created = repo.create({ id: sender.id, branchId: sourceId!, manage: false }, { ...shipment, trackingNumber,
      items: [{ kind: "description", description, quantity: index + 0.5 }] })
    expect(created).toHaveProperty("id")
    expected.set(trackingNumber, description + " × " + (index + 0.5))
  }
  const list = (await get("sender", path + "?search=BULKCONT&page=2")).json()
  expect(list.total).toBe(501)
  expect(list.items).toHaveLength(25)
  for (const item of list.items) {
    expect(item.contents).toHaveLength(1)
    expect(item.contents[0].name + " × " + item.contents[0].quantity).toBe(expected.get(item.trackingNumber))
  }
  const csv = await get("sender", path + "/export?search=BULKCONT")
  expect(csv.statusCode).toBe(200)
  const records = parse(csv.body, { columns: true, bom: true })
  expect(records).toHaveLength(501)
  for (const row of records) expect(row["محتويات الشحنة"]).toBe(expected.get(row["رقم التتبع"]))
})
