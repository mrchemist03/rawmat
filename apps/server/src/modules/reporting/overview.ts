import { auditActionLabel, formatMinor, overviewSchema, purchaseStatus, purchaseStatusLabels } from "@rawmat/shared"
import type { Overview } from "@rawmat/shared"
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, lte, notInArray, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDatabase } from "../../db/database.js"
import { auditLog, branches, purchaseRequests, shipments, trackingEvents } from "../../db/schema.js"
import { can } from "../auth/permissions.js"
import type { AuthAccess, AuthOptions } from "../auth/routes.js"
import { countLowStock } from "../inventory/repository.js"
import { readMonthlySpending } from "../purchases/costs.js"
import { allowExport, sendCsv } from "./csv.js"

const day = 86_400_000
const noQuery = z.strictObject({})

function readOverview(db: AppDatabase, now: number, viewCosts: boolean): Overview {
  const date = new Date(now)
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
  return db.transaction((tx) => {
    const grouped = new Map(tx.select({ status: purchaseRequests.status, total: count() }).from(purchaseRequests)
      .groupBy(purchaseRequests.status).all().map(({ status, total }) => [status, total]))
    const statuses = Object.fromEntries(purchaseStatus.options.map((status) => [status, grouped.get(status) ?? 0]))
    const overduePurchases = tx.select({ total: count() }).from(purchaseRequests)
      .where(and(lt(purchaseRequests.neededOn, date.toISOString().slice(0, 10)),
        inArray(purchaseRequests.status, ["submitted", "approved", "ordered", "partially_received"]))).get()?.total ?? 0
    const inTransit = tx.select({ total: count() }).from(shipments)
      .where(inArray(shipments.status, ["picked_up", "in_transit", "out_for_delivery"])).get()?.total ?? 0
    const overdue = tx.select({ total: count() }).from(shipments)
      .where(and(isNull(shipments.receivedAt), notInArray(shipments.status, ["delivered", "returned"]),
        lte(sql`coalesce(${shipments.trackingChangedAt}, ${shipments.createdAt})`, now - 3 * day))).get()?.total ?? 0

    const delivery = tx.select({ id: trackingEvents.shipmentId,
      time: sql<number>`min(${trackingEvents.occurredAt})`.as("delivered_at") }).from(trackingEvents)
      .innerJoin(shipments, eq(shipments.id, trackingEvents.shipmentId))
      .where(and(eq(trackingEvents.status, "delivered"), eq(shipments.status, "delivered"),
        gte(trackingEvents.occurredAt, sql`unixepoch(${shipments.dispatchedOn}) * 1000`),
        lte(trackingEvents.occurredAt, now))).groupBy(trackingEvents.shipmentId).as("first_delivery")
    const deliveredThisMonth = tx.select({ total: count() }).from(delivery)
      .where(and(gte(delivery.time, start), lt(delivery.time, end))).get()?.total ?? 0
    const source = alias(branches, "route_source")
    const destination = alias(branches, "route_destination")
    const routes = tx.select({
      sourceId: source.id, sourceName: source.name, destinationId: destination.id, destinationName: destination.name,
      count: count(),
      averageDays: sql<number>`avg(julianday(${delivery.time} / 1000.0, 'unixepoch', 'start of day') - julianday(${shipments.dispatchedOn}))`,
    }).from(delivery).innerJoin(shipments, eq(shipments.id, delivery.id))
      .innerJoin(source, eq(source.id, shipments.sourceId)).innerJoin(destination, eq(destination.id, shipments.destinationId))
      .groupBy(source.id, destination.id).orderBy(asc(source.name), asc(destination.name), asc(source.id), asc(destination.id)).all()
    const activity = tx.select({ id: auditLog.id, action: auditLog.action, occurredAt: auditLog.occurredAt }).from(auditLog)
      .where(inArray(auditLog.entity, ["material", "purchase_request", "shipment"]))
      .orderBy(desc(auditLog.occurredAt), desc(auditLog.id)).limit(10).all()

    return overviewSchema.parse({
      month: date.toISOString().slice(0, 7), purchases: { statuses, overdue: overduePurchases },
      lowStock: countLowStock(tx), shipments: { inTransit, overdue, deliveredThisMonth, routes }, activity,
      ...(viewCosts ? { spending: readMonthlySpending(tx, start, end) } : {}),
    })
  })
}

function* overviewRows(data: Overview) {
  for (const status of purchaseStatus.options) yield ["الشراء", purchaseStatusLabels[status], data.purchases.statuses[status], ""]
  yield ["الشراء", "طلبات تجاوزت تاريخ الحاجة", data.purchases.overdue, ""]
  yield ["المخزون", "مواد تحت الحد الأدنى", data.lowStock, ""]
  yield ["الشحنات", "في الطريق", data.shipments.inTransit, ""]
  yield ["الشحنات", "متأخرة", data.shipments.overdue, ""]
  yield ["الشحنات", "سُلّمت في " + data.month, data.shipments.deliveredThisMonth, ""]
  for (const route of data.shipments.routes) yield ["متوسط المدة", route.sourceName + " → " + route.destinationName,
    Number(route.averageDays.toFixed(2)), "يوم"]
  for (const entry of data.activity) yield ["آخر العمليات", auditActionLabel(entry.action), new Date(entry.occurredAt).toISOString(), ""]
  for (const entry of data.spending ?? []) {
    yield ["الإنفاق", "إنفاق " + data.month, formatMinor(entry.totalMinor, entry.currency), entry.currency]
    for (const material of entry.materials) yield ["أعلى المواد إنفاقًا", material.name, formatMinor(material.amountMinor, entry.currency), entry.currency]
  }
}

export function registerOverview(app: FastifyInstance, auth: AuthAccess, options: AuthOptions) {
  for (const exporting of [false, true]) {
    app.get("/api/overview" + (exporting ? "/export" : ""), async (request, reply) => {
      const principal = auth.touch(request, reply)
      if (!principal || principal.mustChangePassword || !can(principal.role, "viewWorkspace")) {
        return reply.code(404).send({ error: "not_found" })
      }
      if (!noQuery.safeParse(request.query).success) return reply.code(400).send({ error: "invalid_input" })
      if (exporting && !allowExport(auth, principal.id, request, reply)) return
      if (!exporting && !auth.reserveOverview(principal.id, request)) {
        return reply.header("Retry-After", "60").code(429).send({ error: "rate_limited" })
      }
      const overview = readOverview(options.db, (options.now ?? Date.now)(), can(principal.role, "viewCosts"))
      return exporting ? sendCsv(reply, "overview.csv", ["القسم", "المؤشر", "القيمة", "الوحدة أو العملة"], overviewRows(overview)) : overview
    })
  }
}
