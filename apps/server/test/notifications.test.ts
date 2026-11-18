import { createHash, createHmac, randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { expect, test, vi } from "vitest"
import { openDatabase } from "../src/db/database.js"
import { branches, categories, materials, notificationOutbox, notificationRecipients, notificationRules, stockMovements,
  units, users } from "../src/db/schema.js"
import { createNotificationWorker, notificationRetention, pruneNotificationHistory, readNotificationDelivery } from "../src/modules/notifications/delivery.js"
import { day, publishShipment, queueScheduledNotices } from "../src/modules/notifications/events.js"
import { createPurchaseRepository } from "../src/modules/purchases/repository.js"
import { createShipmentRepository } from "../src/modules/shipments/repository.js"

const typeFixture = "purchase.submitted"
const fixturePhone = "+12025550111"

test("commits a purchase notice once and retries the signed request after n8n returns", async () => {
  const database = openDatabase(":memory:")
  const { db } = database
  const branch = randomUUID()
  const destination = randomUUID()
  const owner = randomUUID()
  const material = randomUUID()
  const category = randomUUID()
  const unit = randomUUID()
  const recipient = randomUUID()
  let now = Date.parse("2026-11-17T12:00:00Z")
  const delivery = { url: new URL("https://receiver.example.invalid/webhook/rawmat"), key: Buffer.alloc(32, 23) }
  const send = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("receiver offline"))
    .mockImplementation(async (_url, request) => {
      const headers = new Headers(request?.headers)
      const body = String(request?.body)
      const result = JSON.parse(body)
      const signature = createHmac("sha256", delivery.key)
        .update(headers.get("x-rawmat-timestamp") + "." + result.id + "." + body).digest("hex")
      expect(headers.get("x-rawmat-signature")).toBe("sha256=" + signature)
      expect(headers.get("x-rawmat-event-id")).toBe(result.id)
      const [header, claims, signed] = headers.get("authorization")!.slice(7).split(".") as [string, string, string]
      expect(signed).toBe(createHmac("sha256", delivery.key.toString("hex")).update(header + "." + claims).digest("base64url"))
      expect(JSON.parse(Buffer.from(claims, "base64url").toString("utf8"))).toEqual({
        iss: "rawmat", aud: "rawmat-notifications", jti: result.id, iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 300, sha256: createHash("sha256").update(body).digest("hex"),
      })
      expect(result.recipients).toEqual([fixturePhone])
      expect(body).not.toContain("private purchase note")
      expect(body).not.toMatch(/price|cost/i)
      return Response.json({ id: result.id, accepted: true }, { status: 202 })
    })
  try {
    db.insert(branches).values([{ id: branch, name: "Source", city: "Test" },
      { id: destination, name: "Destination", city: "Test" }]).run()
    db.insert(users).values({ id: owner, name: "Fixture", loginName: "fixture", role: "admin", passwordHash: "fixture" }).run()
    db.insert(categories).values({ id: category, name: "Category" }).run()
    db.insert(units).values({ id: unit, name: "Unit" }).run()
    db.insert(materials).values({ id: material, name: "Material", code: "FIXTURE", unitId: unit, categoryId: category, minimumQuantity: 2 }).run()
    db.insert(notificationRecipients).values({ id: recipient, name: "Fixture", phone: fixturePhone, active: true }).run()
    db.insert(notificationRules).values([typeFixture, "purchase.overdue", "shipment.attention", "inventory.low"].map((event) => ({
      event: event as typeof notificationRules.$inferInsert.event, enabled: true, recipientIds: [recipient],
    }))).run()
    const actor = { id: owner, canCreate: true, canManage: true, canApprove: true, canViewCosts: true }
    const purchases = createPurchaseRepository(db, () => now)
    const purchase = purchases.create(actor, { branchId: branch, supplierId: null, neededOn: "2026-11-16",
      notes: "private purchase note", items: [{ materialId: material, quantity: 5 }] })
    if (typeof purchase === "string") throw new Error(purchase)
    expect(purchases.transition(actor, purchase.id, "submitted", 1)).toBe("saved")
    expect(purchases.transition(actor, purchase.id, "submitted", 1)).toBe("saved")
    expect(db.select().from(notificationOutbox).all()).toHaveLength(1)

    const worker = createNotificationWorker(db, delivery, () => now, send)
    db.update(notificationRules).set({ enabled: false }).where(eq(notificationRules.event, "purchase.overdue")).run()
    await worker.run()
    const first = db.select().from(notificationOutbox).get()
    expect(first).toMatchObject({ state: "pending", attempts: 1, lastError: "connection", nextAttemptAt: now + 60_000 })
    await worker.run()
    expect(send).toHaveBeenCalledTimes(1)
    now += 60_000
    const restarted = createNotificationWorker(db, delivery, () => now, send)
    await Promise.all([restarted.run(), worker.run()])
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0]?.[1]?.body).toBe(send.mock.calls[1]?.[1]?.body)
    expect(db.select().from(notificationOutbox).get()).toMatchObject({ id: first?.id, state: "sent", attempts: 2,
      message: "", data: {}, recipients: [] })

    db.update(notificationRules).set({ enabled: true }).where(eq(notificationRules.event, "purchase.overdue")).run()
    db.insert(stockMovements).values({ id: randomUUID(), branchId: branch, materialId: material, quantity: "3", kind: "fixture",
      referenceId: randomUUID(), referenceItemId: randomUUID(), referenceRevision: 1, occurredAt: now }).run()
    const shipments = createShipmentRepository(db, () => now)
    const shipment = shipments.create({ id: owner, branchId: branch, manage: true }, {
      sourceId: branch, destinationId: destination, trackingNumber: "FIXTURE009", dispatchedOn: "2026-11-17",
      items: [{ kind: "material", materialId: material, quantity: 2 }],
    })
    expect(shipment).toHaveProperty("id")
    if (typeof shipment === "string") throw new Error(shipment)
    expect(db.select().from(notificationOutbox).all().map(({ event }) => event)).toEqual([typeFixture, "inventory.low"])
    db.insert(notificationRules).values({ event: "shipment.updated", enabled: true, recipientIds: [recipient] }).run()
    const shipmentRow = { id: shipment.id, trackingNumber: "FIXTURE009", status: "registered" as const }
    publishShipment(db, shipmentRow, "in_transit", 2, now)
    const shipmentNotice = db.select().from(notificationOutbox).all().find(({ event }) => event === "shipment.updated")
    expect(shipmentNotice?.message).toContain("• Material × 2 Unit")
    expect(shipmentNotice?.message).not.toMatch(/price|cost|private purchase note/i)
    db.delete(notificationOutbox).where(eq(notificationOutbox.id, shipmentNotice!.id)).run()
    now += 3 * day
    queueScheduledNotices(db, now)
    queueScheduledNotices(db, now)
    expect(db.select().from(notificationOutbox).all().map(({ event }) => event))
      .toEqual([typeFixture, "inventory.low", "purchase.overdue", "shipment.attention"])
    db.update(notificationOutbox).set({ state: "sent", sentAt: now }).run()
    now += notificationRetention + day
    pruneNotificationHistory(db, now)
    queueScheduledNotices(db, now)
    expect(db.select().from(notificationOutbox).all()).toHaveLength(0)
  } finally {
    database.close()
  }
})

test("keeps long shipment contents within the existing webhook limit and preserves the latest update", () => {
  const database = openDatabase(":memory:")
  try {
    const { db } = database
    const now = 1_800_000_000_000
    const source = randomUUID()
    const destination = randomUUID()
    const owner = randomUUID()
    const recipient = randomUUID()
    db.insert(branches).values([{ id: source, name: "Source", city: "Fixture" }, { id: destination, name: "Destination", city: "Fixture" }]).run()
    db.insert(users).values({ id: owner, name: "Fixture", loginName: "fixture", passwordHash: "fixture", role: "admin" }).run()
    db.insert(notificationRecipients).values({ id: recipient, name: "Fixture", phone: fixturePhone, active: true }).run()
    db.insert(notificationRules).values({ event: "shipment.updated", enabled: true, recipientIds: [recipient] }).run()
    const repo = createShipmentRepository(db, () => now)
    const actor = { id: owner, branchId: source, manage: true }
    const created = repo.create(actor, { sourceId: source, destinationId: destination, trackingNumber: "FIXTURE100",
      dispatchedOn: "2026-11-17", items: Array.from({ length: 100 }, () => ({
        kind: "description" as const, description: "بند\n" + "صنف ".repeat(45), quantity: 2,
      })) })
    if (typeof created === "string") throw new Error(created)
    expect(repo.update(actor, created.id, { revision: 1, status: "in_transit", location: "", description: "تحديث ".repeat(80).trim() })).toBe("saved")
    const notice = db.select().from(notificationOutbox).get()!
    expect(notice.message.length).toBeLessThanOrEqual(1024)
    expect(notice.message).toContain("بنود أخرى")
    expect(notice.message).toContain("آخر تحديث للحالة " + "تحديث ".repeat(80).trim())
    expect(notice.message).not.toContain("بند\n")
  } finally {
    database.close()
  }
})

test("expires overdue queue entries without touching recent rows or a delivery in progress", () => {
  const database = openDatabase(":memory:")
  try {
    const { db } = database
    const now = 1_800_000_000_000
    const old = now - notificationRetention - 1
    const recipient = { id: randomUUID(), revision: 1 }
    const seed = { event: "notification.test" as const, recipients: [recipient], occurredAt: old,
      message: "ephemeral fixture", data: { value: "fixture" } }
    db.insert(notificationOutbox).values([
      { ...seed, id: randomUUID(), dedupeKey: "old-pending", nextAttemptAt: old },
      { ...seed, id: randomUUID(), dedupeKey: "old-failed", nextAttemptAt: old, state: "failed" },
      { ...seed, id: randomUUID(), dedupeKey: "recent", nextAttemptAt: now },
      { ...seed, id: randomUUID(), dedupeKey: "leased", nextAttemptAt: old, leaseUntil: now + 10_000 },
    ]).run()
    pruneNotificationHistory(db, now)
    const rows = new Map(db.select().from(notificationOutbox).all().map((row) => [row.dedupeKey, row]))
    expect(rows.get("old-pending")).toMatchObject({ state: "failed", lastError: "expired", nextAttemptAt: now,
      message: "", data: {}, recipients: [] })
    expect(rows.has("old-failed")).toBe(false)
    expect(rows.get("recent")?.state).toBe("pending")
    expect(rows.get("leased")?.state).toBe("pending")
  } finally {
    database.close()
  }
})

test("requires HTTPS configuration and keeps unacknowledged deliveries for retry", async () => {
  expect(readNotificationDelivery({})).toBeUndefined()
  expect(() => readNotificationDelivery({ N8N_WEBHOOK_URL: "http://example.invalid/" })).toThrow()
  const key = Buffer.alloc(32, 23)
  const url = new URL("https://receiver.example.invalid/webhook/rawmat")
  const database = openDatabase(":memory:")
  try {
    const { db } = database
    const recipient = randomUUID()
    const id = randomUUID()
    let now = 1_800_000_000_000
    db.insert(notificationRecipients).values({ id: recipient, active: true, name: "Test", phone: fixturePhone }).run()
    db.insert(notificationOutbox).values({ id, event: "notification.test", dedupeKey: "fixture", occurredAt: now,
      recipients: [{ id: recipient, revision: 1 }], nextAttemptAt: now, message: "Test", data: {} }).run()
    const send = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ accepted: true, id: randomUUID() }))
    const worker = createNotificationWorker(db, { key, url }, () => now, send)
    for (let attempt = 0; attempt < 5; attempt++) {
      await worker.run()
      now = db.select().from(notificationOutbox).get()!.nextAttemptAt
    }
    await worker.run()
    expect(send).toHaveBeenCalledTimes(5)
    expect(db.select().from(notificationOutbox).get()).toMatchObject({ state: "failed", lastError: "response", attempts: 5, sentAt: null })
  } finally {
    database.close()
  }
})
