import { createHmac } from "node:crypto"
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm"
import type { AppDatabase } from "../../db/database.js"
import { notificationOutbox, notificationRecipients } from "../../db/schema.js"
import { day, queueScheduledNotices } from "./events.js"

const pending = sql`${notificationOutbox.state} = 'pending'`
const delays = [60_000, 300_000, 1_800_000, 7_200_000]
const acknowledgementLimit = 4096
type Job = typeof notificationOutbox.$inferSelect
type Failure = NonNullable<Job["lastError"]>
export type NotificationDelivery = { url: URL; key: Buffer }

export function readNotificationDelivery(env: NodeJS.ProcessEnv): NotificationDelivery | undefined {
  if (!env.N8N_WEBHOOK_URL) return
  let url: URL
  try {
    url = new URL(env.N8N_WEBHOOK_URL)
  } catch {
    throw new Error("Invalid N8N_WEBHOOK_URL")
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Invalid N8N_WEBHOOK_URL")
  if (!env.N8N_WEBHOOK_SECRET || !/^[\da-f]{64}$/i.test(env.N8N_WEBHOOK_SECRET)) {
    throw new Error("N8N_WEBHOOK_SECRET must contain 32 random bytes in hexadecimal")
  }
  return { url, key: Buffer.from(env.N8N_WEBHOOK_SECRET, "hex") }
}

async function accepted(response: Response, id: string) {
  if (!response.body) return false
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.length
    if (size > acknowledgementLimit) {
      await reader.cancel()
      return false
    }
    chunks.push(value)
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks, size).toString("utf8"))
    return result?.accepted === true && result?.id === id
  } catch {
    return false
  }
}

export function createNotificationWorker(db: AppDatabase, delivery: NotificationDelivery, now: () => number,
  sendRequest = fetch) {
  function claim(time: number) {
    return db.transaction((tx) => {
      const rows = tx.select().from(notificationOutbox).where(and(pending, lte(notificationOutbox.nextAttemptAt, time),
        or(isNull(notificationOutbox.leaseUntil), lte(notificationOutbox.leaseUntil, time))))
        .orderBy(asc(notificationOutbox.nextAttemptAt), asc(notificationOutbox.id)).limit(4).all()
      if (!rows.length) return []
      const leaseUntil = time + 30_000
      tx.update(notificationOutbox).set({ leaseUntil }).where(inArray(notificationOutbox.id, rows.map(({ id }) => id))).run()
      return rows.map((row) => ({ ...row, leaseUntil }))
    }, { behavior: "immediate" })
  }

  async function deliver(job: Job, shutdown?: AbortSignal): Promise<Failure | null> {
    const revisions = new Map(job.recipients.map(({ id, revision }) => [id, revision]))
    const recipients = db.select().from(notificationRecipients)
      .where(and(eq(notificationRecipients.active, true), inArray(notificationRecipients.id, [...revisions.keys()])))
      .orderBy(asc(notificationRecipients.id)).all()
      .filter(({ id, revision }) => revision === revisions.get(id)).map(({ phone }) => phone)
    if (!recipients.length) return "recipients"
    const body = JSON.stringify({ id: job.id, event: job.event, occurred_at: new Date(job.occurredAt).toISOString(),
      recipients, message: job.message, data: job.data })
    const timestamp = String(Math.floor(now() / 1000))
    const signature = createHmac("sha256", delivery.key).update(timestamp + "." + job.id + "." + body).digest("hex")
    const timeout = AbortSignal.timeout(10_000)
    const signal = shutdown ? AbortSignal.any([timeout, shutdown]) : timeout
    try {
      const response = await sendRequest(delivery.url, { method: "POST", body, signal, redirect: "error", headers: {
        "content-type": "application/json", "x-rawmat-timestamp": timestamp, "x-rawmat-event-id": job.id,
        "x-rawmat-signature": "sha256=" + signature,
      } })
      if (!response.ok) {
        await response.body?.cancel()
        return "http"
      }
      return await accepted(response, job.id) ? null : "response"
    } catch {
      return "connection"
    }
  }

  async function complete(job: Job & { leaseUntil: number }, shutdown?: AbortSignal) {
    const failure = await deliver(job, shutdown)
    const where = and(eq(notificationOutbox.id, job.id), eq(notificationOutbox.leaseUntil, job.leaseUntil))
    if (shutdown?.aborted && failure) {
      db.update(notificationOutbox).set({ leaseUntil: null }).where(where).run()
      return
    }
    const time = now()
    const attempts = job.attempts + 1
    const delay = delays[attempts - 1]
    const state = !failure ? "sent" : delay !== undefined && failure !== "recipients" ? "pending" : "failed"
    db.update(notificationOutbox).set({ state, attempts, lastError: failure, leaseUntil: null,
      sentAt: state === "sent" ? time : null, nextAttemptAt: state === "pending" ? time + (delay ?? 0) : time }).where(where).run()
  }

  let nextReview = 0
  let running: Promise<void> | undefined
  return {
    run(shutdown?: AbortSignal) {
      if (running) return running
      if (shutdown?.aborted) return Promise.resolve()
      const time = now()
      if (time >= nextReview && !queueScheduledNotices(db, time)) nextReview = time + day
      running = Promise.allSettled(claim(time).map((job) => complete(job, shutdown))).then((results) => {
        if (results.some(({ status }) => status === "rejected")) throw new Error("Notification processing failed")
      }).finally(() => { running = undefined })
      return running
    },
    reviewSoon() { nextReview = 0 },
  }
}
