import { randomUUID } from "node:crypto"
import { listQuerySchema, notificationHistorySchema, notificationRecipientInput, notificationRuleInput,
  notificationsSettingsSchema, notificationType, pageSize, recipientLimit } from "@rawmat/shared"
import { and, asc, count, desc, eq, gte, inArray, sql } from "drizzle-orm"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"
import { auditLog, notificationOutbox, notificationRecipients, notificationRules } from "../../db/schema.js"
import { can } from "../auth/permissions.js"
import type { AuthAccess, AuthOptions } from "../auth/routes.js"
import { createNotificationWorker } from "./delivery.js"
import type { NotificationDelivery } from "./delivery.js"
import { queueNotice } from "./events.js"

const path = "/api/notifications"
const idParam = z.strictObject({ id: z.uuid() })
const ruleParam = z.strictObject({ event: notificationType })
const testDelay = 120_000

export function registerNotifications(app: FastifyInstance, auth: AuthAccess, options: AuthOptions, delivery?: NotificationDelivery) {
  const { db, now = Date.now } = options
  const worker = delivery && createNotificationWorker(db, delivery, now)
  const shutdown = new AbortController()
  async function run() {
    try {
      await worker?.run(shutdown.signal)
    } catch {
      app.log.error("notification worker failed")
    }
  }
  if (worker) {
    let timer: NodeJS.Timeout | undefined
    app.addHook("onListen", async () => {
      timer = setInterval(() => void run(), 5_000).unref()
      void run()
    })
    app.addHook("preClose", async () => {
      clearInterval(timer)
      shutdown.abort()
      await run()
    })
  }

  function authorize(request: FastifyRequest, reply: FastifyReply, write = false) {
    const principal = auth.principal(request)
    if (!principal || principal.mustChangePassword || !can(principal.role, "manageNotifications")) {
      reply.code(404).send({ error: "not_found" })
      return
    }
    const session = auth.touch(request, reply)
    if (!session || session.mustChangePassword || !can(session.role, "manageNotifications")) {
      reply.code(404).send({ error: "not_found" })
      return
    }
    if (write && !auth.reserveManagementWrite(session.id, request)) {
      reply.header("Retry-After", "900").code(429).send({ error: "rate_limited" })
      return
    }
    return session
  }

  const invalid = (reply: FastifyReply) => reply.code(400).send({ error: "invalid_input" })
  const missing = (reply: FastifyReply) => reply.code(404).send({ error: "not_found" })
  const unavailable = (reply: FastifyReply) => reply.code(409).send({ error: "notification_unconfigured" })

  app.get(path, async (request, reply) => {
    if (!authorize(request, reply)) return
    const recipients = db.select({
      id: notificationRecipients.id, name: notificationRecipients.name, phone: notificationRecipients.phone,
      active: notificationRecipients.active,
    }).from(notificationRecipients).orderBy(asc(notificationRecipients.name), asc(notificationRecipients.id)).all()
    const stored = new Map(db.select().from(notificationRules).all().map((rule) => [rule.event, rule]))
    return notificationsSettingsSchema.parse({ configured: Boolean(worker), recipients,
      rules: notificationType.options.map((event) => stored.get(event) ?? { event, enabled: false, recipientIds: [] }) })
  })

  app.get(path + "/history", async (request, reply) => {
    if (!authorize(request, reply)) return
    const query = listQuerySchema.safeParse(request.query)
    if (!query.success) return invalid(reply)
    const items = db.select({
      id: notificationOutbox.id, event: notificationOutbox.event, state: notificationOutbox.state,
      attempts: notificationOutbox.attempts, occurredAt: notificationOutbox.occurredAt, nextAttemptAt: notificationOutbox.nextAttemptAt,
      sentAt: notificationOutbox.sentAt, lastError: notificationOutbox.lastError,
    }).from(notificationOutbox).orderBy(desc(notificationOutbox.occurredAt), desc(notificationOutbox.id))
      .limit(pageSize).offset(((query.data.page ?? 1) - 1) * pageSize).all()
    const total = db.select({ value: count() }).from(notificationOutbox).get()?.value ?? 0
    return notificationHistorySchema.parse({ items, total })
  })

  async function saveRecipient(request: FastifyRequest, reply: FastifyReply) {
    const actor = authorize(request, reply, true)
    if (!actor) return
    const input = notificationRecipientInput.safeParse(request.body)
    const param = request.method === "PUT" ? idParam.safeParse(request.params) : undefined
    if (!input.success || param?.success === false) return invalid(reply)
    const id = param?.data.id ?? randomUUID()
    const result = db.transaction((tx) => {
      const current = tx.select().from(notificationRecipients).where(eq(notificationRecipients.id, id)).get()
      if (param && !current) return "missing"
      const existing = tx.select({ id: notificationRecipients.id }).from(notificationRecipients)
        .where(eq(notificationRecipients.phone, input.data.phone)).get()
      if (existing && existing.id !== id) return "notification_duplicate"
      if (!current && (tx.select({ value: count() }).from(notificationRecipients).get()?.value ?? 0) >= recipientLimit) {
        return "notification_recipient_limit"
      }
      if (current) {
        const revised = current.active !== input.data.active || current.phone !== input.data.phone
        tx.update(notificationRecipients).set({ ...input.data, revision: revised ? current.revision + 1 : current.revision })
          .where(eq(notificationRecipients.id, id)).run()
      } else tx.insert(notificationRecipients).values({ ...input.data, id }).run()
      tx.insert(auditLog).values({ id: randomUUID(), actorId: actor.id, entity: "notification_recipient", entityId: id,
        action: "notification_recipient_saved", occurredAt: now(), after: { active: input.data.active } }).run()
      return "saved"
    }, { behavior: "immediate" })
    if (result === "missing") return missing(reply)
    if (result !== "saved") return reply.code(409).send({ error: result })
    worker?.reviewSoon()
    return reply.code(204).send()
  }
  app.post(path + "/recipients", { bodyLimit: 4096 }, saveRecipient)
  app.put(path + "/recipients/:id", { bodyLimit: 4096 }, saveRecipient)

  app.put(path + "/rules/:event", { bodyLimit: 4096 }, async (request, reply) => {
    const actor = authorize(request, reply, true)
    if (!actor) return
    const input = notificationRuleInput.safeParse(request.body)
    const params = ruleParam.safeParse(request.params)
    if (!input.success || !params.success) return invalid(reply)
    const { event } = params.data
    const saved = db.transaction((tx) => {
      const recipients = input.data.recipientIds.length ? tx.select({ active: notificationRecipients.active })
        .from(notificationRecipients).where(inArray(notificationRecipients.id, input.data.recipientIds)).all() : []
      if (recipients.length !== input.data.recipientIds.length || (input.data.enabled && !recipients.some(({ active }) => active))) return false
      tx.insert(notificationRules).values({ event, ...input.data }).onConflictDoUpdate({ target: notificationRules.event, set: input.data }).run()
      tx.insert(auditLog).values({ id: randomUUID(), actorId: actor.id, entity: "notification_rule", entityId: event,
        action: "notification_rule_saved", occurredAt: now(), after: { enabled: input.data.enabled, recipientCount: recipients.length } }).run()
      return true
    }, { behavior: "immediate" })
    if (!saved) return reply.code(400).send({ error: "notification_select_recipient" })
    worker?.reviewSoon()
    return reply.code(204).send()
  })

  app.post(path + "/recipients/:id/test", { bodyLimit: 1024 }, async (request, reply) => {
    if (!authorize(request, reply, true)) return
    const params = idParam.safeParse(request.params)
    if (!params.success) return missing(reply)
    if (!worker) return unavailable(reply)
    const { id } = params.data
    const time = now()
    const prefix = "test:" + id + ":"
    const result = db.transaction((tx) => {
      const recipient = tx.select({ id: notificationRecipients.id, revision: notificationRecipients.revision })
        .from(notificationRecipients).where(and(eq(notificationRecipients.id, id), eq(notificationRecipients.active, true))).get()
      if (!recipient) return "missing"
      if (tx.select({ id: notificationOutbox.id }).from(notificationOutbox).where(and(
        gte(notificationOutbox.occurredAt, time - testDelay),
        sql`${notificationOutbox.dedupeKey} GLOB ${prefix + "*"}`)).get()) return "limited"
      queueNotice(tx, { event: "notification.test", dedupeKey: prefix + time, occurredAt: time,
        message: "رسالة تجريبية من Rawmat", data: {} }, [recipient])
      return "queued"
    }, { behavior: "immediate" })
    if (result === "missing") return missing(reply)
    if (result === "limited") return reply.header("Retry-After", "120").code(429).send({ error: "notification_test_limited" })
    setImmediate(() => void run())
    return reply.code(202).send()
  })

  app.post(path + "/history/:id/retry", { bodyLimit: 1024 }, async (request, reply) => {
    if (!authorize(request, reply, true)) return
    const params = idParam.safeParse(request.params)
    if (!params.success) return missing(reply)
    if (!worker) return unavailable(reply)
    const result = db.update(notificationOutbox)
      .set({ state: "pending", attempts: 0, nextAttemptAt: now(), lastError: null })
      .where(and(eq(notificationOutbox.id, params.data.id), eq(notificationOutbox.state, "failed"),
        sql`${notificationOutbox.lastError} <> 'recipients'`)).run()
    if (!result.changes) return missing(reply)
    setImmediate(() => void run())
    return reply.code(202).send()
  })
}
