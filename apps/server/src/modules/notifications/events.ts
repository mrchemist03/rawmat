import { randomUUID } from "node:crypto"
import type { NotificationEvent, NotificationType, PurchaseStatus, ShipmentStatus } from "@rawmat/shared"
import { and, asc, eq, inArray, isNull, lt, lte, notInArray, sql } from "drizzle-orm"
import type { AppDatabase } from "../../db/database.js"
import { notificationOutbox, notificationRecipients, notificationRules, purchaseRequests, shipments } from "../../db/schema.js"

export const day = 86_400_000
type Connection = Pick<AppDatabase, "select" | "insert">
type Notice = { event: NotificationEvent; dedupeKey: string; occurredAt: number; message: string; data: Record<string, string> }
type Recipient = { id: string; revision: number }

function recipientsFor(db: Connection, event: NotificationType) {
  const rule = db.select().from(notificationRules)
    .where(and(eq(notificationRules.event, event), eq(notificationRules.enabled, true))).get()
  if (!rule?.recipientIds.length) return []
  return db.select({ id: notificationRecipients.id, revision: notificationRecipients.revision }).from(notificationRecipients)
    .where(and(inArray(notificationRecipients.id, rule.recipientIds), eq(notificationRecipients.active, true))).all()
}

export function queueNotice(db: Connection, notice: Notice, recipients: Recipient[]) {
  if (!recipients.length) return
  db.insert(notificationOutbox).values({ ...notice, id: randomUUID(), recipients, nextAttemptAt: notice.occurredAt })
    .onConflictDoNothing({ target: notificationOutbox.dedupeKey }).run()
}

function publish(db: Connection, notice: Notice & { event: NotificationType }) {
  queueNotice(db, notice, recipientsFor(db, notice.event))
}

const purchaseMessages = {
  submitted: "طلب شراء ينتظر الاعتماد",
  approved: "اعتُمد طلب الشراء",
  rejected: "رُفض طلب الشراء",
  received: "اكتمل استلام طلب الشراء",
  partially_received: "سُجّل استلام جزئي لطلب الشراء",
}
const purchaseEvents = {
  submitted: "purchase.submitted", approved: "purchase.decided", rejected: "purchase.decided",
  received: "purchase.received", partially_received: "purchase.received",
} as const

export function publishPurchase(db: Connection, row: { number: string; id: string }, status: PurchaseStatus, revision: number, time: number) {
  if (!Object.hasOwn(purchaseEvents, status)) return
  const key = status as keyof typeof purchaseEvents
  const event = purchaseEvents[key]
  publish(db, { event, dedupeKey: event + ":" + row.id + ":" + revision, occurredAt: time,
    message: purchaseMessages[key] + " " + row.number, data: { number: row.number, status } })
}

const shipmentLabels: Record<ShipmentStatus, string> = {
  registered: "مسجّلة", picked_up: "استلمها الناقل", in_transit: "في الطريق", out_for_delivery: "خرجت للتوصيل",
  delivered: "سُلّمت", exception: "مشكلة", returned: "مرتجعة",
}

export function publishShipment(db: Connection, row: { id: string; trackingNumber: string; status: ShipmentStatus },
  status: ShipmentStatus, revision: number, time: number) {
  if (status === row.status) return
  const awb = row.trackingNumber
  const message = "الشحنة " + awb + " · " + shipmentLabels[status]
  const events: NotificationType[] = ["shipment.updated"]
  if (status === "delivered") events.push("shipment.delivered")
  if (status === "exception") events.push("shipment.attention")
  for (const event of events) publish(db, { event, dedupeKey: event + ":" + row.id + ":" + revision, occurredAt: time,
    message, data: { awb, status } })
}

export function publishLowStock(db: Connection, material: { id: string; code: string; name: string },
  shipmentId: string, branch: string, time: number) {
  publish(db, { event: "inventory.low", dedupeKey: "inventory.low:" + shipmentId + ":" + material.id, occurredAt: time,
    message: "انخفض مخزون " + material.name + " عن الحد الأدنى في " + branch,
    data: { materialCode: material.code, branch } })
}

const reviewLimit = 100

export function queueScheduledNotices(db: AppDatabase, time: number) {
  return db.transaction((tx) => {
    let more = false
    const overdue = recipientsFor(tx, "purchase.overdue")
    if (overdue.length) {
      const key = sql<string>`'purchase.overdue:' || ${purchaseRequests.id} || ':' || ${purchaseRequests.neededOn}`
      const rows = tx.select({ key, number: purchaseRequests.number, neededOn: purchaseRequests.neededOn }).from(purchaseRequests)
        .where(and(lt(purchaseRequests.neededOn, new Date(time).toISOString().slice(0, 10)),
          inArray(purchaseRequests.status, ["submitted", "approved", "ordered", "partially_received"]),
          sql`not exists (select 1 from notification_outbox as queued where queued.dedupe_key = ${key})`))
        .orderBy(asc(purchaseRequests.neededOn), asc(purchaseRequests.id)).limit(reviewLimit).all()
      for (const row of rows) queueNotice(tx, { event: "purchase.overdue", dedupeKey: row.key, occurredAt: time,
        message: "تجاوز طلب الشراء " + row.number + " تاريخ الحاجة", data: { number: row.number, neededOn: row.neededOn } }, overdue)
      more = rows.length === reviewLimit
    }
    const attention = recipientsFor(tx, "shipment.attention")
    if (attention.length) {
      const activity = sql<number>`coalesce(${shipments.trackingChangedAt}, ${shipments.createdAt})`
      const key = sql<string>`'shipment.stale:' || ${shipments.id} || ':' || ${activity}`
      const rows = tx.select({ key, awb: shipments.trackingNumber }).from(shipments)
        .where(and(isNull(shipments.receivedAt), notInArray(shipments.status, ["delivered", "returned", "exception"]),
          lte(activity, time - 3 * day), sql`not exists (select 1 from notification_outbox as queued where queued.dedupe_key = ${key})`))
        .orderBy(asc(activity), asc(shipments.id)).limit(reviewLimit).all()
      for (const row of rows) queueNotice(tx, { event: "shipment.attention", dedupeKey: row.key, occurredAt: time,
        message: "لم يرد تحديث للشحنة " + row.awb + " منذ ثلاثة أيام", data: { awb: row.awb, reason: "stale" } }, attention)
      more ||= rows.length === reviewLimit
    }
    return more
  }, { behavior: "immediate" })
}
