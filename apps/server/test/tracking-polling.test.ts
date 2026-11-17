import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { openDatabase } from "../src/db/database.js"
import { auditLog, branches, shipments, stockMovements, trackingEvents, users } from "../src/db/schema.js"
import { createTrackingPoller, trackingIdleLimit, trackingState } from "../src/modules/shipments/polling.js"
import { createShipmentRepository } from "../src/modules/shipments/repository.js"
import type { TrackingProvider, TrackingResult } from "../src/modules/shipments/tracking.js"

const awb = "FIXTURE001"
const milestone = 1_800_000_000_000
const interval = 60 * 60_000
const actor = { id: randomUUID(), branchId: randomUUID(), manage: false }
const destination = randomUUID()
let time: number
let stored: ReturnType<typeof openDatabase>
let repo: ReturnType<typeof createShipmentRepository>
let id: string

function shipment() {
  return stored.db.select().from(shipments).where(eq(shipments.id, id)).get()!
}

beforeEach(() => {
  time = milestone
  stored = openDatabase(":memory:")
  stored.db.insert(branches).values([
    { id: actor.branchId, name: "Source", city: "Test city" }, { id: destination, name: "Destination", city: "Test city" },
  ]).run()
  stored.db.insert(users).values({ id: actor.id, name: "Fixture", loginName: "fixture", role: "user",
    branchId: actor.branchId, passwordHash: "fixture" }).run()
  repo = createShipmentRepository(stored.db, () => time, true)
  const created = repo.create(actor, { sourceId: actor.branchId, destinationId: destination, trackingNumber: awb,
    dispatchedOn: "2026-11-10", items: [{ kind: "description", description: "Documents", quantity: 1 }] })
  if (typeof created === "string") throw new Error(created)
  id = created.id
})

afterEach(() => stored.close())

test("persists and deduplicates chronological events across workers and stops at delivery without crediting inventory", async () => {
  const pickup = { status: "picked_up" as const, code: "PICKUP", description: "Collected", location: "", occurredAt: milestone - 10 }
  const transit = { ...pickup, status: "in_transit" as const, code: "TRANSIT", occurredAt: milestone - 5 }
  const delivery = { ...pickup, status: "delivered" as const, code: "DELIVERED", occurredAt: milestone + interval }
  let complete!: (results: TrackingResult[]) => void
  const track = vi.fn<TrackingProvider["track"]>()
    .mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    .mockResolvedValueOnce([{ awb, events: [delivery, pickup, transit] }])
  const first = createTrackingPoller(stored.db, { track }, () => time)
  const running = first.run()
  const second = createTrackingPoller(stored.db, { track }, () => time)
  await second.run()
  expect(track).toHaveBeenCalledTimes(1)
  expect(track).toHaveBeenCalledWith([awb], expect.any(AbortSignal))
  complete([{ awb, events: [{ ...transit, raw: '{"fixture":true}' }, pickup] }])
  await running
  expect(shipment()).toMatchObject({ status: "in_transit", nextPollAt: milestone + interval, lastPolledAt: milestone })
  expect(repo.detail(actor, id)?.events.map(({ status }) => status)).toEqual(["registered", "in_transit", "picked_up"])
  time += interval
  await second.run()
  time += interval
  await first.run()
  expect(track).toHaveBeenCalledTimes(2)
  expect(shipment()).toMatchObject({ status: "delivered", receivedAt: null, revision: 4 })
  expect(stored.db.select().from(trackingEvents).all()).toHaveLength(4)
  expect(stored.db.select({ action: auditLog.action }).from(auditLog).all().map(({ action }) => action))
    .toEqual(["shipment_created", "shipment_tracking_synced", "shipment_tracking_synced"])
  expect(stored.db.select().from(stockMovements).all()).toHaveLength(0)
  expect(JSON.stringify(repo.detail(actor, id))).not.toContain('fixture')
})

test("backs off malformed responses and allows only an authorized, throttled refresh after inactivity", async () => {
  const track = vi.fn<TrackingProvider["track"]>()
    .mockResolvedValueOnce([{ awb, events: [] }])
    .mockResolvedValueOnce([{ awb: "UNRELATED7", events: [] }])
    .mockResolvedValueOnce([{ awb, events: [] }])
  const worker = createTrackingPoller(stored.db, { track }, () => time)
  await worker.run()
  time += interval
  await worker.run()
  expect(shipment()).toMatchObject({ lastPolledAt: milestone, nextPollAt: milestone + 3 * interval, pollFailures: 1 })
  expect(trackingState(shipment(), time)).toBe("retrying")
  time = milestone + trackingIdleLimit
  await worker.run()
  expect(track).toHaveBeenCalledTimes(2)
  expect(trackingState(shipment(), time)).toBe("stalled")
  expect(repo.requestRefresh({ id: randomUUID(), branchId: null, manage: false }, id)).toBe("missing")
  expect(repo.requestRefresh(actor, id)).toBe("queued")
  expect(repo.requestRefresh(actor, id)).toBe("tracking_refresh_limited")
  await worker.run()
  expect(track).toHaveBeenCalledTimes(3)
  expect(shipment()).toMatchObject({ lastPolledAt: time, pollFailures: 0 })
  expect(trackingState(shipment(), time)).toBe("stalled")
})

test("releases unfinished work on shutdown for the next process", async () => {
  const shutdown = new AbortController()
  const unresponsive = vi.fn<TrackingProvider["track"]>(() => new Promise(() => {}))
  const first = createTrackingPoller(stored.db, { track: unresponsive }, () => time)
  const running = first.run(shutdown.signal)
  expect(shipment().pollLeaseUntil).not.toBeNull()
  shutdown.abort()
  await running
  expect(shipment()).toMatchObject({ pollLeaseUntil: null, nextPollAt: 0, pollFailures: 0, lastPolledAt: null })
  const second = createTrackingPoller(stored.db, { track: async () => [{ awb, events: [] }] }, () => time)
  await second.run()
  expect(shipment().lastPolledAt).toBe(time)
})

test("a tracking response for the previous number cannot change a corrected shipment", async () => {
  const corrected = "FIXTURE002"
  const { promise, resolve } = Promise.withResolvers<TrackingResult[]>()
  const occurrence = { status: "in_transit" as const, code: "TRANSIT", description: "Fixture", location: "",
    occurredAt: milestone - 10 }
  const track = vi.fn<TrackingProvider["track"]>().mockReturnValueOnce(promise)
    .mockResolvedValueOnce([{ awb: corrected, events: [occurrence] }])
  const worker = createTrackingPoller(stored.db, { track }, () => time)
  const pending = worker.run()
  expect(track).toHaveBeenCalledWith([awb], expect.any(AbortSignal))
  expect(repo.edit({ ...actor, manage: true }, id, { sourceId: actor.branchId, destinationId: destination,
    trackingNumber: corrected, revision: 1, dispatchedOn: "2026-11-10",
    items: [{ kind: "description", description: "Documents", quantity: 1 }] })).toBe("tracking_changed")
  resolve([{ awb, events: [occurrence] }])
  await pending
  expect(shipment()).toMatchObject({ trackingNumber: corrected, status: "registered", revision: 2, lastPolledAt: null })
  await worker.run()
  expect(track).toHaveBeenLastCalledWith([corrected], expect.any(AbortSignal))
  expect(shipment()).toMatchObject({ status: "in_transit", revision: 3 })
  expect(repo.detail(actor, id)?.lastEvent.status).toBe("in_transit")
})
