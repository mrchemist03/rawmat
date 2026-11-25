import { randomUUID } from "node:crypto"
import { expect, test } from "vitest"
import { openDatabase } from "../src/db/database.js"
import { branches, notificationOutbox, notificationRecipients, notificationRules, users } from "../src/db/schema.js"
import { createNotificationWorker } from "../src/modules/notifications/delivery.js"
import { createTrackingPoller } from "../src/modules/shipments/polling.js"
import { createShipmentRepository } from "../src/modules/shipments/repository.js"

function fixture() {
  const stored = openDatabase(":memory:")
  const { db } = stored
  const source = randomUUID(), destination = randomUUID(), owner = randomUUID()
  const recipients = Array.from({ length: 4 }, (_, index) => ({ id: randomUUID(), revision: 1,
    name: "Fixture " + index, phone: "+1202555011" + index, active: index !== 3 }))
  let now = 1_800_000_000_000
  db.insert(branches).values([{ id: source, name: "Source", city: "Fixture" },
    { id: destination, name: "Destination", city: "Fixture" }]).run()
  db.insert(users).values({ id: owner, name: "Fixture", loginName: "fixture", role: "user", passwordHash: "fixture", branchId: source }).run()
  db.insert(notificationRecipients).values(recipients).run()
  const actor = { id: owner, branchId: source, manage: false }
  const repo = createShipmentRepository(db, () => now, true)
  const created = repo.create(actor, { sourceId: source, destinationId: destination, trackingNumber: "ROUTING001",
    dispatchedOn: "2026-11-20", items: [{ kind: "description", description: "Fixture contents", quantity: 1 }] })
  if (typeof created === "string") throw new Error(created)
  return { ...stored, actor, repo, id: created.id, recipients, now: () => now, advance() { now += 3_600_000 } }
}

for (const status of ["delivered", "exception"] as const) {
  const specific = status === "delivered" ? "shipment.delivered" : "shipment.attention"
  test.each([
    { name: "general only", general: [0], special: [], enabled: true, expectedGeneral: [0], expectedSpecial: [] },
    { name: "specialized only", general: [], special: [0], enabled: true, expectedGeneral: [], expectedSpecial: [0] },
    { name: "same recipient in both", general: [0], special: [0], enabled: true, expectedGeneral: [], expectedSpecial: [0] },
    { name: "overlapping and separate recipients", general: [0, 1], special: [0, 2], enabled: true, expectedGeneral: [1], expectedSpecial: [0, 2] },
    { name: "specialized rule disabled", general: [0, 1], special: [0, 2], enabled: false, expectedGeneral: [0, 1], expectedSpecial: [] },
    { name: "specialized recipient inactive", general: [0, 1], special: [3], enabled: true, expectedGeneral: [0, 1], expectedSpecial: [] },
  ])("routes " + status + " once per recipient: $name", async ({ general, special, enabled, expectedGeneral, expectedSpecial }) => {
    const stored = fixture()
    try {
      const { db, recipients } = stored
      const ids = (indexes: number[]) => indexes.map((index) => recipients[index]!.id)
      db.insert(notificationRules).values([
        { event: "shipment.updated", enabled: true, recipientIds: ids(general) },
        { event: specific, enabled, recipientIds: ids(special) },
      ]).run()
      const occurrence = stored.now() - 20
      const poller = createTrackingPoller(db, { track: async () => [{ awb: "ROUTING001", events: [
        { status, code: "FIRST", description: "Fixture update", location: "Fixture", occurredAt: occurrence },
        { status, code: "REPEATED", description: "Fixture update", location: "Fixture", occurredAt: occurrence + 1 },
      ] }] }, stored.now)
      await poller.run()
      stored.advance()
      await poller.run()
      const rows = db.select().from(notificationOutbox).all()
      const groups = new Map(rows.map((row) => [row.event, row.recipients.map(({ id }) => id).sort()]))
      expect(groups.get("shipment.updated") ?? []).toEqual(ids(expectedGeneral).sort())
      expect(groups.get(specific) ?? []).toEqual(ids(expectedSpecial).sort())
      expect(rows).toHaveLength(Number(expectedGeneral.length > 0) + Number(expectedSpecial.length > 0))
      const sent: string[] = []
      const worker = createNotificationWorker(db, { url: new URL("https://receiver.example.invalid"), key: Buffer.alloc(32, 17) },
        stored.now, async (_url, options) => {
          const body = JSON.parse(String(options?.body))
          sent.push(...body.recipients)
          return Response.json({ accepted: true, id: body.id })
        })
      await worker.run()
      expect(sent.sort()).toEqual([...expectedGeneral, ...expectedSpecial].map((index) => recipients[index]!.phone).sort())
      expect(new Set(sent).size).toBe(sent.length)
      expect(db.select().from(notificationOutbox).all().every((row) => row.state === "sent" && row.attempts === 1)).toBe(true)
    } finally { stored.close() }
  })
}

test("retries only the unsuccessful recipient group after the other shipment group succeeds", async () => {
  const stored = fixture()
  try {
    const { db, repo, actor, id, recipients } = stored
    db.insert(notificationRules).values([
      { event: "shipment.updated", enabled: true, recipientIds: [recipients[0]!.id, recipients[1]!.id] },
      { event: "shipment.delivered", enabled: true, recipientIds: [recipients[0]!.id, recipients[2]!.id] },
    ]).run()
    expect(repo.update(actor, id, { revision: 1, status: "delivered", description: "Shipment Delivered", location: "" })).toBe("saved")
    stored.advance()
    const attempts = { general: 0, specialized: 0 }
    const accepted: string[] = []
    const worker = createNotificationWorker(db, { url: new URL("https://receiver.example.invalid"), key: Buffer.alloc(32, 17) },
      stored.now, async (_url, options) => {
        const body = JSON.parse(String(options?.body))
        if (body.event === "shipment.updated") {
          attempts.general++
          if (attempts.general === 1) throw new Error("Fixture receiver unavailable")
        } else attempts.specialized++
        accepted.push(...body.recipients)
        return Response.json({ accepted: true, id: body.id })
      })
    await worker.run()
    expect(db.select().from(notificationOutbox).all().map(({ state }) => state).sort()).toEqual(["pending", "sent"])
    stored.advance()
    await worker.run()
    expect(attempts).toEqual({ general: 2, specialized: 1 })
    expect(accepted.sort()).toEqual(recipients.slice(0, 3).map(({ phone }) => phone).sort())
    expect(new Set(accepted).size).toBe(3)
  } finally { stored.close() }
})

test("preserves a later genuine exception after recovery rather than suppressing all future shipment notices", () => {
  const stored = fixture()
  try {
    const { db, actor, repo, id, recipients } = stored
    db.insert(notificationRules).values(["shipment.updated", "shipment.attention"].map((event) => ({
      event: event as "shipment.updated" | "shipment.attention", enabled: true, recipientIds: [recipients[0]!.id],
    }))).run()
    expect(repo.update(actor, id, { revision: 1, status: "exception", description: "Fixture exception", location: "" })).toBe("saved")
    expect(repo.update(actor, id, { revision: 2, status: "in_transit", description: "Fixture recovery", location: "" })).toBe("saved")
    expect(repo.update(actor, id, { revision: 3, status: "exception", description: "Fixture exception", location: "" })).toBe("saved")
    const rows = db.select().from(notificationOutbox).all()
    expect(rows).toHaveLength(3)
    expect(rows.filter(({ event }) => event === "shipment.attention")).toHaveLength(2)
    expect(rows.filter(({ event }) => event === "shipment.updated")).toHaveLength(1)
    expect(new Set(rows.map(({ dedupeKey }) => dedupeKey)).size).toBe(3)
  } finally { stored.close() }
})
