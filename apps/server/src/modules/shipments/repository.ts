import { randomUUID } from "node:crypto"
import { pageSize } from "@rawmat/shared"
import type { ShipmentInput, ShipmentQuery, ShipmentReceipt, ShipmentUpdate } from "@rawmat/shared"
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import type { AppDatabase } from "../../db/database.js"
import { auditLog, branches, materials, shipmentItems, shipments, stockMovements, trackingEvents, units } from "../../db/schema.js"
import { Quantity } from "../inventory/quantity.js"
import { branchBalance } from "../inventory/repository.js"
import { publishLowStock, publishShipment } from "../notifications/events.js"
import { trackingRefreshDelay, trackingState } from "./polling.js"
import { canUpdateTracking, ManualProvider, trackingFinished } from "./tracking.js"
import type { TrackingEvent } from "./tracking.js"

type Actor = { id: string; branchId: string | null; manage: boolean }
type Connection = Pick<AppDatabase, "select" | "insert" | "update">
type Shipment = typeof shipments.$inferSelect
type StockRow = typeof stockMovements.$inferInsert
const source = alias(branches, "shipment_source")
const destination = alias(branches, "shipment_destination")
const last = alias(trackingEvents, "shipment_last")
const eventFields = { id: trackingEvents.id, status: trackingEvents.status, description: trackingEvents.description,
  location: trackingEvents.location, occurredAt: trackingEvents.occurredAt }
const summary = {
  id: shipments.id, trackingNumber: shipments.trackingNumber, sourceName: source.name, destinationName: destination.name,
  dispatchedOn: shipments.dispatchedOn, status: shipments.status, receivedAt: shipments.receivedAt,
  lastEvent: { id: last.id, status: last.status, description: last.description, location: last.location, occurredAt: last.occurredAt },
}

function canTrack(row: Shipment, actor: Actor) {
  return actor.manage || row.createdBy === actor.id || actor.branchId === row.sourceId || actor.branchId === row.destinationId
}

function canReceive(row: Shipment, actor: Actor) {
  return actor.manage || actor.branchId === (row.status === "returned" ? row.sourceId : row.destinationId)
}

export function createShipmentRepository(db: AppDatabase, now: () => number, automatic = false) {
  const provider = new ManualProvider()
  function audit(tx: Connection, actor: Actor, shipmentId: string, action: string, after: Record<string, string | number>) {
    tx.insert(auditLog).values({ id: randomUUID(), actorId: actor.id, entity: "shipment", entityId: shipmentId,
      action, occurredAt: now(), after }).run()
  }

  function addEvent(tx: Connection, shipmentId: string, revision: number, event: TrackingEvent) {
    tx.insert(trackingEvents).values({ ...event, id: randomUUID(), shipmentId, revision, source: "manual" }).run()
  }

  function listing() {
    return db.select(summary).from(shipments).innerJoin(source, eq(source.id, shipments.sourceId))
      .innerJoin(destination, eq(destination.id, shipments.destinationId))
      .innerJoin(last, eq(last.id, sql`coalesce((select event.id from tracking_events as event
        where event.shipment_id = ${shipments.id} and event.revision > 1
        order by event.occurred_at desc, event.revision desc limit 1),
        (select first.id from tracking_events as first where first.shipment_id = ${shipments.id} and first.revision = 1))`))
  }

  return {
    findByTrackingNumber(trackingNumber: string) {
      return db.select({ id: shipments.id }).from(shipments).where(eq(shipments.trackingNumber, trackingNumber)).get()
    },

    list({ page = 1, status, sort = "newest", search = "" }: ShipmentQuery) {
      const term = search.toUpperCase()
      const filter = and(status ? eq(shipments.status, status) : undefined, term
        ? sql`(instr(${shipments.trackingNumber}, ${term}) > 0 or instr(upper(${source.name}), ${term}) > 0 or instr(upper(${destination.name}), ${term}) > 0)`
        : undefined)
      const items = listing().where(filter)
        .orderBy(sort === "dispatch" ? desc(shipments.dispatchedOn) : desc(shipments.createdAt), asc(shipments.id))
        .limit(pageSize).offset((page - 1) * pageSize).all()
      const total = db.select({ total: count() }).from(shipments).innerJoin(source, eq(source.id, shipments.sourceId))
        .innerJoin(destination, eq(destination.id, shipments.destinationId)).where(filter).get()?.total ?? 0
      return { items, total }
    },

    detail(actor: Actor, id: string) {
      const row = db.select().from(shipments).where(eq(shipments.id, id)).get()
      const header = listing().where(eq(shipments.id, id)).get()
      if (!row || !header) return
      const items = db.select({ id: shipmentItems.id, name: sql<string>`coalesce(${materials.name}, ${shipmentItems.description})`,
        unitName: units.name, quantity: shipmentItems.quantity, receivedQuantity: shipmentItems.receivedQuantity })
        .from(shipmentItems).leftJoin(materials, eq(shipmentItems.materialId, materials.id))
        .leftJoin(units, eq(materials.unitId, units.id)).where(eq(shipmentItems.shipmentId, id)).orderBy(shipmentItems.position).all()
      const events = db.select(eventFields).from(trackingEvents).where(eq(trackingEvents.shipmentId, id))
        .orderBy(desc(trackingEvents.occurredAt), desc(trackingEvents.revision)).limit(100).all()
      const finished = trackingFinished(row.status, row.receivedAt)
      return { ...header, revision: row.revision, items, events,
        tracking: automatic ? { state: trackingState(row, now()), lastPolledAt: row.lastPolledAt } : null,
        actions: {
        update: !finished && canTrack(row, actor),
        receive: row.receivedAt === null && canReceive(row, actor),
        refresh: automatic && !finished && canTrack(row, actor),
      } }
    },

    requestRefresh(actor: Actor, id: string) {
      return db.transaction((tx) => {
        const row = tx.select().from(shipments).where(eq(shipments.id, id)).get()
        if (!row || !automatic || !canTrack(row, actor)) return "missing"
        if (trackingFinished(row.status, row.receivedAt)) return "invalid_shipment_transition"
        const time = now()
        if ((row.pollLeaseUntil ?? 0) > time || (row.lastRefreshAt !== null && time - row.lastRefreshAt < trackingRefreshDelay)) {
          return "tracking_refresh_limited"
        }
        tx.update(shipments).set({ lastRefreshAt: time, nextPollAt: time }).where(eq(shipments.id, id)).run()
        return "queued"
      }, { behavior: "immediate" })
    },

    create(actor: Actor, input: ShipmentInput) {
      return db.transaction((tx) => {
        const existing = tx.select({ id: shipments.id }).from(shipments)
          .where(eq(shipments.trackingNumber, input.trackingNumber)).get()
        if (existing) return { id: existing.id, duplicate: true }
        const selectedBranches = tx.select({ id: branches.id, name: branches.name }).from(branches)
          .where(and(inArray(branches.id, [input.sourceId, input.destinationId]), eq(branches.active, true))).all()
        if (selectedBranches.length !== 2) return "invalid_shipment_reference"
        const id = randomUUID()
        const movements: StockRow[] = []
        const lowStock: { id: string; code: string; name: string }[] = []
        const items: (typeof shipmentItems.$inferInsert)[] = []
        const occurredAt = now()
        for (const [position, inputItem] of input.items.entries()) {
          const itemId = randomUUID()
          const quantity = new Quantity(inputItem.quantity)
          if (inputItem.kind === "material") {
            const material = tx.select({ id: materials.id, name: materials.name, code: materials.code,
              minimumQuantity: materials.minimumQuantity }).from(materials)
              .where(and(eq(materials.id, inputItem.materialId), eq(materials.archived, false))).get()
            if (!material) return "invalid_shipment_reference"
            const balance = branchBalance(tx, material.id, input.sourceId)
            if (balance.lt(quantity)) return "insufficient_stock"
            if (balance.gte(material.minimumQuantity) && balance.minus(quantity).lt(material.minimumQuantity)) lowStock.push(material)
            movements.push({ id: randomUUID(), branchId: input.sourceId, materialId: material.id,
              quantity: quantity.negated().toFixed(), kind: "shipment_dispatch", referenceId: id, referenceItemId: itemId,
              referenceRevision: 1, occurredAt })
          }
          items.push({ id: itemId, shipmentId: id, position, quantity: quantity.toFixed(),
            materialId: inputItem.kind === "material" ? inputItem.materialId : null,
            description: inputItem.kind === "description" ? inputItem.description : null })
        }
        const { items: _items, ...fields } = input
        tx.insert(shipments).values({ ...fields, id, createdAt: occurredAt, createdBy: actor.id }).run()
        tx.insert(shipmentItems).values(items).run()
        if (movements.length) tx.insert(stockMovements).values(movements).run()
        const sourceName = selectedBranches.find((row) => row.id === input.sourceId)?.name ?? ""
        addEvent(tx, id, 1, provider.event("registered", "سُجّلت الشحنة", sourceName, occurredAt))
        for (const material of lowStock) publishLowStock(tx, material, id, sourceName, occurredAt)
        audit(tx, actor, id, "shipment_created", { itemCount: items.length })
        return { id, duplicate: false }
      }, { behavior: "immediate" })
    },

    update(actor: Actor, id: string, input: ShipmentUpdate) {
      return db.transaction((tx) => {
        const row = tx.select().from(shipments).where(eq(shipments.id, id)).get()
        if (!row || !canTrack(row, actor)) return "missing"
        if (row.revision !== input.revision) return "stale_shipment"
        if (row.receivedAt !== null || !canUpdateTracking(row.status, input.status)) return "invalid_shipment_transition"
        const event = provider.event(input.status, input.description, input.location, now())
        const latest = tx.select().from(trackingEvents).where(eq(trackingEvents.shipmentId, id))
          .orderBy(desc(trackingEvents.occurredAt), desc(trackingEvents.revision)).limit(1).get()
        if (latest && latest.status === event.status && latest.description === event.description && latest.location === event.location) return "saved"
        const revision = row.revision + 1
        if (latest) event.occurredAt = Math.max(event.occurredAt, latest.occurredAt + 1)
        tx.update(shipments).set({ revision, status: input.status, trackingChangedAt: now() }).where(eq(shipments.id, id)).run()
        addEvent(tx, id, revision, event)
        audit(tx, actor, id, "shipment_tracking_updated", { status: input.status, revision })
        publishShipment(tx, row, input.status, revision, event.occurredAt)
        return "saved"
      }, { behavior: "immediate" })
    },

    receive(actor: Actor, id: string, input: ShipmentReceipt) {
      return db.transaction((tx) => {
        const row = tx.select().from(shipments).where(eq(shipments.id, id)).get()
        if (!row || !canReceive(row, actor)) return "missing"
        const items = tx.select({ id: shipmentItems.id, quantity: shipmentItems.quantity, receivedQuantity: shipmentItems.receivedQuantity,
          materialId: shipmentItems.materialId, mergedIntoId: materials.mergedIntoId }).from(shipmentItems)
          .leftJoin(materials, eq(materials.id, shipmentItems.materialId)).where(eq(shipmentItems.shipmentId, id)).all()
        const quantities = new Map(input.items.map(({ itemId, quantity }) => [itemId, new Quantity(quantity)]))
        if (row.receivedAt !== null) {
          return row.revision === input.revision + 1 && items.length === quantities.size &&
            items.every(({ id, receivedQuantity }) => receivedQuantity !== null && quantities.get(id)?.eq(receivedQuantity))
            ? "saved" : "shipment_closed"
        }
        if (row.revision !== input.revision) return "stale_shipment"
        if (items.length !== quantities.size || items.some(({ id, quantity }) => {
          const actual = quantities.get(id)
          return !actual || actual.lt(0) || actual.gt(quantity)
        })) return "invalid_shipment_receipt"
        const returned = row.status === "returned"
        const branchId = returned ? row.sourceId : row.destinationId
        const revision = row.revision + 1
        const latest = tx.select({ occurredAt: trackingEvents.occurredAt }).from(trackingEvents)
          .where(eq(trackingEvents.shipmentId, id)).orderBy(desc(trackingEvents.occurredAt)).limit(1).get()
        const occurredAt = Math.max(now(), latest?.occurredAt ?? 0)
        const status = returned ? "returned" : "delivered"
        const movements: StockRow[] = []
        for (const item of items) {
          const actual = quantities.get(item.id)!
          tx.update(shipmentItems).set({ receivedQuantity: actual.toFixed() }).where(eq(shipmentItems.id, item.id)).run()
          if (item.materialId && !actual.isZero()) movements.push({ id: randomUUID(), branchId,
            materialId: item.mergedIntoId ?? item.materialId, quantity: actual.toFixed(),
            kind: returned ? "shipment_return" : "shipment_receipt", referenceId: id, referenceItemId: item.id,
            referenceRevision: revision, occurredAt })
        }
        if (movements.length) tx.insert(stockMovements).values(movements).run()
        const location = tx.select({ name: branches.name }).from(branches).where(eq(branches.id, branchId)).get()?.name ?? ""
        tx.update(shipments).set({ status, revision, receivedAt: occurredAt }).where(eq(shipments.id, id)).run()
        addEvent(tx, id, revision, { ...provider.event(status, returned ? "تأكّد استلام المرتجع" : "تأكّد الاستلام في الوجهة", location, occurredAt),
          code: returned ? "manual:return_confirmed" : "manual:receipt_confirmed" })
        audit(tx, actor, id, "shipment_received", { status, revision, itemCount: items.length })
        publishShipment(tx, row, status, revision, occurredAt)
        return "saved"
      }, { behavior: "immediate" })
    },
  }
}
