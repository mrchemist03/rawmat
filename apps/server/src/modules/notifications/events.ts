import { randomUUID } from "node:crypto"
import { aramexTrackingUrl, shipmentStatusLabels, translateTrackingDescription } from "@rawmat/shared"
import type { NotificationEvent, NotificationType, PurchaseStatus, ShipmentStatus } from "@rawmat/shared"
import { and, asc, desc, eq, inArray, isNull, like, lt, lte, ne, notInArray, sql } from "drizzle-orm"
import type { AppDatabase } from "../../db/database.js"
import { branches, materials, notificationOutbox, notificationRecipients, notificationRules, purchaseRequests,
  shipmentItems, shipments, trackingEvents, units } from "../../db/schema.js"
import { supersededTrackingSource } from "../shipments/tracking.js"

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

function oneLine(value: string) {
  return value.replace(/\s+/gu, " ").trim()
}

function clip(value: string, limit: number) {
  if (value.length <= limit) return value
  return value.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/u, "") + "…"
}

function shipmentMessage(db: Connection, id: string, awb: string, fallback: string, attention = false) {
  const latest = db.select({ description: trackingEvents.description }).from(trackingEvents)
    .where(and(eq(trackingEvents.shipmentId, id), ne(trackingEvents.source, supersededTrackingSource)))
    .orderBy(sql`${trackingEvents.code} = 'manual:registered'`, desc(trackingEvents.occurredAt), desc(trackingEvents.revision)).get()
  const description = latest ? translateTrackingDescription(latest.description) : fallback
  const update = attention ? fallback + " · " + description : description
  const destination = db.select({ name: branches.name }).from(shipments)
    .innerJoin(branches, eq(branches.id, shipments.destinationId)).where(eq(shipments.id, id)).get()
  const recipient = clip(oneLine(destination?.name ?? "شعبة غير محددة"), 120)
  const header = "رقم الشحنة : " + awb + "\nاسم المستلم: " + recipient + "\n\nمحتويات الشحنة :\n"
  const footer = "\n\nآخر تحديث : " + clip(oneLine(update), 550) + "\n\nرابط التتبع المباشر\n" + aramexTrackingUrl(awb)
  const items = db.select({ name: sql<string>`coalesce(${materials.name}, ${shipmentItems.description})`,
    quantity: shipmentItems.quantity, unitName: units.name }).from(shipmentItems)
    .leftJoin(materials, eq(materials.id, shipmentItems.materialId)).leftJoin(units, eq(units.id, materials.unitId))
    .where(eq(shipmentItems.shipmentId, id)).orderBy(asc(shipmentItems.position)).limit(100).all()
  const budget = 1024 - header.length - footer.length
  const lines: string[] = []
  for (const [index, item] of items.entries()) {
    const rest = index + 1 < items.length ? "\n… و" + (items.length - index - 1) + " بنود أخرى" : ""
    const available = budget - lines.join("\n").length - (lines.length ? 1 : 0) - rest.length
    const line = oneLine(item.name) + " × " + item.quantity + (item.unitName ? " " + oneLine(item.unitName) : "")
    if (available < 30) {
      lines.push("… و" + (items.length - index) + " بنود أخرى")
      break
    }
    lines.push(clip(line, available))
  }
  return header + (lines.length ? lines.join("\n") : "لم تُسجّل محتويات") + footer
}

export function publishShipment(db: Connection, row: { id: string; trackingNumber: string; status: ShipmentStatus },
  status: ShipmentStatus, revision: number, time: number) {
  if (status === row.status) return
  const awb = row.trackingNumber
  const message = shipmentMessage(db, row.id, awb, shipmentStatusLabels[status])
  const events: NotificationType[] = ["shipment.updated"]
  if (status === "delivered") events.push("shipment.delivered")
  if (status === "exception") events.push("shipment.attention")
  for (const event of events) publish(db, { event, dedupeKey: event + ":" + row.id + ":" + revision, occurredAt: time,
    message, data: { awb, status } })
}

export function discardShipmentNotices(db: Pick<AppDatabase, "delete">, id: string, trackingNumber: string) {
  db.delete(notificationOutbox).where(and(
    inArray(notificationOutbox.state, ["pending", "failed"]),
    like(notificationOutbox.dedupeKey, "shipment.%:" + id + ":%"),
    sql`json_extract(${notificationOutbox.data}, '$.awb') = ${trackingNumber}`,
  )).run()
}

export function publishLowStock(db: Connection, material: { id: string; code: string; name: string },
  shipmentId: string, branch: string, time: number, revision = 1) {
  const dedupeKey = "inventory.low:" + shipmentId + ":" + material.id + (revision === 1 ? "" : ":" + revision)
  publish(db, { event: "inventory.low", dedupeKey, occurredAt: time,
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
      const rows = tx.select({ key, id: purchaseRequests.id, number: purchaseRequests.number, neededOn: purchaseRequests.neededOn }).from(purchaseRequests)
        .where(and(lt(purchaseRequests.neededOn, new Date(time).toISOString().slice(0, 10)),
          inArray(purchaseRequests.status, ["submitted", "approved", "ordered", "partially_received"]),
          sql`${purchaseRequests.overdueNotifiedOn} is not ${purchaseRequests.neededOn}`))
        .orderBy(asc(purchaseRequests.neededOn), asc(purchaseRequests.id)).limit(reviewLimit).all()
      for (const row of rows) {
        queueNotice(tx, { event: "purchase.overdue", dedupeKey: row.key, occurredAt: time,
          message: "تجاوز طلب الشراء " + row.number + " تاريخ الحاجة", data: { number: row.number, neededOn: row.neededOn } }, overdue)
        tx.update(purchaseRequests).set({ overdueNotifiedOn: row.neededOn }).where(eq(purchaseRequests.id, row.id)).run()
      }
      more = rows.length === reviewLimit
    }
    const attention = recipientsFor(tx, "shipment.attention")
    if (attention.length) {
      const activity = sql<number>`coalesce(${shipments.trackingChangedAt}, ${shipments.createdAt})`
      const key = sql<string>`'shipment.stale:' || ${shipments.id} || ':' || ${activity}`
      const rows = tx.select({ key, activity, id: shipments.id, awb: shipments.trackingNumber }).from(shipments)
        .where(and(isNull(shipments.receivedAt), notInArray(shipments.status, ["delivered", "returned", "exception"]),
          lte(activity, time - 3 * day), sql`${shipments.staleNotifiedActivityAt} is not ${activity}`))
        .orderBy(asc(activity), asc(shipments.id)).limit(reviewLimit).all()
      for (const row of rows) {
        queueNotice(tx, { event: "shipment.attention", dedupeKey: row.key, occurredAt: time,
          message: shipmentMessage(tx, row.id, row.awb, "لم يرد تحديث منذ ثلاثة أيام", true),
          data: { awb: row.awb, reason: "stale" } }, attention)
        tx.update(shipments).set({ staleNotifiedActivityAt: row.activity }).where(eq(shipments.id, row.id)).run()
      }
      more ||= rows.length === reviewLimit
    }
    return more
  }, { behavior: "immediate" })
}
