import { randomUUID } from "node:crypto"
import { addAbortListener } from "node:events"
import { and, asc, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm"
import { z } from "zod"
import type { AppDatabase } from "../../db/database.js"
import { auditLog, shipments, trackingEvents } from "../../db/schema.js"
import { publishShipment } from "../notifications/events.js"
import { canUpdateTracking, trackingFinished, trackingResultSchema } from "./tracking.js"
import type { TrackingProvider, TrackingResult } from "./tracking.js"

const minute = 60_000
export const trackingIdleLimit = 30 * 24 * 60 * minute
export const trackingRefreshDelay = 2 * minute
const batchSize = 20
const pollResults = z.array(trackingResultSchema).max(batchSize)
const active = sql`${shipments.receivedAt} is null and ${shipments.status} not in ('delivered', 'returned')`
const lastChange = sql<number>`coalesce(${shipments.trackingChangedAt}, ${shipments.createdAt})`
type Shipment = typeof shipments.$inferSelect
type PollClaim = { id: string; trackingNumber: string; lease: number }

export function trackingState(row: Shipment, now: number) {
  if (trackingFinished(row.status, row.receivedAt)) return "finished"
  if (row.pollLeaseUntil !== null && row.pollLeaseUntil > now) return "pending"
  if (row.lastRefreshAt !== null && row.lastRefreshAt === row.nextPollAt) return "pending"
  if (now - (row.trackingChangedAt ?? row.createdAt) >= trackingIdleLimit) return "stalled"
  if (row.pollFailures > 0) return "retrying"
  return row.lastPolledAt === null ? "pending" : "idle"
}

export function createTrackingPoller(db: AppDatabase, provider: TrackingProvider, now: () => number, intervalMs = 60 * minute) {
  function claim(time: number) {
    return db.transaction((tx) => {
      const rows = tx.select({ id: shipments.id, trackingNumber: shipments.trackingNumber }).from(shipments)
        .where(and(active, lte(shipments.nextPollAt, time),
          or(isNull(shipments.pollLeaseUntil), lte(shipments.pollLeaseUntil, time)),
          or(gt(lastChange, time - trackingIdleLimit), eq(shipments.lastRefreshAt, shipments.nextPollAt))))
        .orderBy(asc(shipments.nextPollAt), asc(shipments.id)).limit(batchSize).all()
      const lease = time + 30_000
      return rows.map((row) => {
        tx.update(shipments).set({ pollLeaseUntil: lease }).where(eq(shipments.id, row.id)).run()
        return { ...row, lease }
      })
    }, { behavior: "immediate" })
  }

  function settle(job: PollClaim, result: TrackingResult | undefined, time: number) {
    db.transaction((tx) => {
      const row = tx.select().from(shipments).where(and(eq(shipments.id, job.id), eq(shipments.pollLeaseUntil, job.lease))).get()
      if (!row) return
      if (trackingFinished(row.status, row.receivedAt)) {
        tx.update(shipments).set({ pollLeaseUntil: null }).where(eq(shipments.id, row.id)).run()
        return
      }
      if (!result) {
        const failures = Math.min(10, row.pollFailures + 1)
        const delay = Math.min(24 * 60 * minute, Math.max(intervalMs, minute) * 2 ** failures)
        tx.update(shipments).set({ nextPollAt: time + delay, pollLeaseUntil: null, pollFailures: failures })
          .where(eq(shipments.id, row.id)).run()
        return
      }

      const previous = tx.select({ occurredAt: trackingEvents.occurredAt }).from(trackingEvents)
        .where(and(eq(trackingEvents.shipmentId, row.id), eq(trackingEvents.source, "carrier")))
        .orderBy(desc(trackingEvents.occurredAt)).limit(1).get()
      let revision = row.revision
      let status = row.status
      let changed = false
      const events = [...result.events].sort((first, second) => first.occurredAt - second.occurredAt)
      for (const event of events) {
        const { code, status: carrierStatus, ...fields } = event
        const inserted = tx.insert(trackingEvents).values({ ...fields, status: carrierStatus ?? status, code: `carrier:${code}`, id: randomUUID(),
          shipmentId: row.id, revision: revision + 1, source: "carrier" })
          .onConflictDoNothing({ target: [trackingEvents.shipmentId, trackingEvents.code, trackingEvents.occurredAt] }).run()
        if (!inserted.changes) continue
        revision++
        if (event.occurredAt >= (previous?.occurredAt ?? 0)) {
          changed = true
          if (carrierStatus && canUpdateTracking(status, carrierStatus)) status = carrierStatus
        }
      }
      tx.update(shipments).set({ revision, status, nextPollAt: time + intervalMs, pollLeaseUntil: null,
        lastPolledAt: time, pollFailures: 0, ...(changed ? { trackingChangedAt: time } : {}) })
        .where(eq(shipments.id, row.id)).run()
      if (status !== row.status) tx.insert(auditLog).values({ id: randomUUID(), entity: "shipment", entityId: row.id,
        action: "shipment_tracking_synced", occurredAt: time, before: { status: row.status }, after: { status } }).run()
      publishShipment(tx, row, status, revision, time)
    }, { behavior: "immediate" })
  }

  let running: Promise<void> | undefined
  function run(signal?: AbortSignal) {
    if (running) return running
    running = poll(signal).finally(() => { running = undefined })
    return running
  }

  async function poll(shutdown?: AbortSignal) {
    if (shutdown?.aborted) return
    const jobs = claim(now())
    if (!jobs.length) return
    const timeout = AbortSignal.timeout(10_000)
    const signal = shutdown ? AbortSignal.any([timeout, shutdown]) : timeout
    const numbers = jobs.map(({ trackingNumber }) => trackingNumber)
    const results = new Map<string, TrackingResult>()
    let abortListener: ReturnType<typeof addAbortListener> | undefined
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        abortListener = addAbortListener(signal, () => reject(signal.reason))
      })
      const parsed = pollResults.parse(await Promise.race([aborted, provider.track(numbers, signal)]))
      signal.throwIfAborted()
      for (const result of parsed) {
        if (!numbers.includes(result.awb) || results.has(result.awb) ||
          result.events.some((event) => event.occurredAt > now() + 24 * 60 * minute)) throw new Error("Invalid tracking batch")
        results.set(result.awb, result)
      }
    } catch {
      results.clear()
    } finally {
      abortListener?.[Symbol.dispose]()
    }
    for (const job of jobs) {
      if (shutdown?.aborted) {
        db.update(shipments).set({ pollLeaseUntil: null })
          .where(and(eq(shipments.id, job.id), eq(shipments.pollLeaseUntil, job.lease))).run()
      } else settle(job, results.get(job.trackingNumber), now())
    }
  }

  return { run }
}
