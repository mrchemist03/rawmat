import { randomUUID } from "node:crypto"
import { pageSize } from "@rawmat/shared"
import type { PurchaseDecision, PurchaseInput, PurchaseQuery, PurchaseReceipt, PurchaseStatus } from "@rawmat/shared"
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm"
import type { AppDatabase } from "../../db/database.js"
import { auditLog, branches, materials, purchaseRequestItems, purchaseRequests, stockMovements, suppliers, units, users } from "../../db/schema.js"
import { canTransition } from "./workflow.js"
import { pricesFor, refreshMaterialCosts, writePrices } from "./costs.js"
import { Quantity } from "../inventory/quantity.js"

type Actor = { id: string; canCreate: boolean; canManage: boolean; canApprove: boolean; canViewCosts: boolean }
type Connection = Pick<AppDatabase, "select" | "insert" | "update" | "delete">
type Snapshot = typeof auditLog.$inferInsert.before

const summaryFields = {
  id: purchaseRequests.id, number: purchaseRequests.number, branchId: purchaseRequests.branchId,
  branchName: branches.name, requesterName: users.name, supplierId: purchaseRequests.supplierId,
  supplierName: suppliers.name, neededOn: purchaseRequests.neededOn, status: purchaseRequests.status,
  createdAt: purchaseRequests.createdAt,
}

function draftActions(row: { status: PurchaseStatus; requestedBy: string }, actor: Actor) {
  const editable = row.status === "draft" && actor.canCreate && (row.requestedBy === actor.id || actor.canManage)
  return { edit: editable, submit: editable && canTransition(row.status, "submitted") }
}

function canReceive(row: { status: PurchaseStatus; requestedBy: string }, actor: Actor) {
  return (actor.canApprove || row.requestedBy === actor.id) && canTransition(row.status, "received")
}

function validReferences(db: Connection, input: Pick<PurchaseInput, "branchId" | "supplierId" | "items">) {
  const branch = db.select({ id: branches.id }).from(branches)
    .where(and(eq(branches.id, input.branchId), eq(branches.active, true))).get()
  if (!branch) return false
  if (input.supplierId && !db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, input.supplierId)).get()) return false
  if (input.items.length === 0) return false
  const active = db.select({ total: count() }).from(materials)
    .where(and(inArray(materials.id, input.items.map(({ materialId }) => materialId)), eq(materials.archived, false))).get()
  return active?.total === input.items.length
}

export function createPurchaseRepository(db: AppDatabase, now: () => number) {
  function audit(tx: Connection, actor: Actor, id: string, action: string, before: Snapshot, after: Snapshot) {
    tx.insert(auditLog).values({
      id: randomUUID(), actorId: actor.id, entityId: id, entity: "purchase_request", action, occurredAt: now(), before, after,
    }).run()
  }

  function insertItems(tx: Connection, id: string, items: PurchaseInput["items"]) {
    tx.insert(purchaseRequestItems).values(items.map((item, position) => ({
      ...item, id: randomUUID(), requestId: id, position,
    }))).run()
  }

  function snapshot(request: Pick<PurchaseInput, "branchId" | "supplierId" | "neededOn">, itemCount: number, revision: number) {
    const { branchId, supplierId, neededOn } = request
    return { branchId, supplierId, neededOn, itemCount, revision }
  }

  return {
    exists(id: string) {
      return Boolean(db.select({ id: purchaseRequests.id }).from(purchaseRequests).where(eq(purchaseRequests.id, id)).get())
    },
    list(actor: Actor, { status, search = "", sort = "newest", page = 1 }: PurchaseQuery) {
      const term = search.toLowerCase()
      const filter = and(status ? eq(purchaseRequests.status, status) : undefined, term
        ? sql`(instr(lower(${purchaseRequests.number}), ${term}) > 0 or instr(lower(${branches.name}), ${term}) > 0 or instr(lower(coalesce(${suppliers.name}, '')), ${term}) > 0)`
        : undefined)
      const rows = db.select({ ...summaryFields, requestedBy: purchaseRequests.requestedBy })
        .from(purchaseRequests).innerJoin(branches, eq(purchaseRequests.branchId, branches.id))
        .innerJoin(users, eq(purchaseRequests.requestedBy, users.id))
        .leftJoin(suppliers, eq(purchaseRequests.supplierId, suppliers.id)).where(filter)
        .orderBy(sort === "neededOn" ? asc(purchaseRequests.neededOn) : desc(purchaseRequests.createdAt), asc(purchaseRequests.id))
        .limit(pageSize).offset((page - 1) * pageSize).all()
      const items = rows.map(({ requestedBy, ...summary }) => ({ ...summary, actions: draftActions({ ...summary, requestedBy }, actor) }))
      const total = db.select({ total: count() }).from(purchaseRequests)
        .innerJoin(branches, eq(purchaseRequests.branchId, branches.id))
        .leftJoin(suppliers, eq(purchaseRequests.supplierId, suppliers.id)).where(filter).get()?.total ?? 0
      return { items, total }
    },

    listBranches(search: string, page: number) {
      const filter = and(eq(branches.active, true), search
        ? sql`instr(lower(${branches.name}), ${search.toLowerCase()}) > 0`
        : undefined)
      const items = db.select({ id: branches.id, name: branches.name }).from(branches).where(filter)
        .orderBy(asc(branches.name), asc(branches.id)).limit(pageSize).offset((page - 1) * pageSize).all()
      return { items, total: db.select({ total: count() }).from(branches).where(filter).get()?.total ?? 0 }
    },

    detail(actor: Actor, id: string) {
      const row = db.select({
        ...summaryFields, requestedBy: purchaseRequests.requestedBy, notes: purchaseRequests.notes, revision: purchaseRequests.revision,
        decisionReason: purchaseRequests.decisionReason,
      }).from(purchaseRequests).innerJoin(branches, eq(purchaseRequests.branchId, branches.id))
        .innerJoin(users, eq(purchaseRequests.requestedBy, users.id))
        .leftJoin(suppliers, eq(purchaseRequests.supplierId, suppliers.id)).where(eq(purchaseRequests.id, id)).get()
      if (!row) return
      const items = db.select({
        id: purchaseRequestItems.id, materialId: materials.id, name: materials.name, code: materials.code, unitName: units.name,
        quantity: purchaseRequestItems.quantity, receivedExact: purchaseRequestItems.receivedExact, archived: materials.archived,
      }).from(purchaseRequestItems).innerJoin(materials, eq(purchaseRequestItems.materialId, materials.id))
        .innerJoin(units, eq(materials.unitId, units.id)).where(eq(purchaseRequestItems.requestId, id))
        .orderBy(asc(purchaseRequestItems.position)).all()
      const { requestedBy, ...details } = row
      return {
        ...details, actions: draftActions(row, actor),
        items: items.map(({ receivedExact, ...item }) => {
          const remaining = new Quantity(item.quantity).minus(receivedExact)
          return { ...item, receivedQuantity: Number(receivedExact), remainingQuantity: remaining.toNumber(), remainingExact: remaining.toFixed() }
        }),
        workflow: {
          approve: actor.canApprove && canTransition(row.status, "approved"),
          reject: actor.canApprove && canTransition(row.status, "rejected"),
          order: actor.canApprove && canTransition(row.status, "ordered"),
          cancel: actor.canApprove && canTransition(row.status, "cancelled"),
          receive: canReceive(row, actor),
          ...(actor.canViewCosts ? { viewCosts: true as const } : {}),
        },
      }
    },

    create(actor: Actor, input: PurchaseInput) {
      return db.transaction((tx) => {
        if (!validReferences(tx, input)) return "invalid_purchase_reference" as const
        const id = randomUUID()
        const { items, ...fields } = input
        tx.insert(purchaseRequests).values({
          ...fields, id, number: `PR-${id.replaceAll("-", "").toUpperCase()}`, requestedBy: actor.id, createdAt: now(),
        }).run()
        insertItems(tx, id, items)
        audit(tx, actor, id, "purchase_created", null, { ...snapshot(fields, items.length, 1), status: "draft" })
        return { id }
      }, { behavior: "immediate" })
    },

    update(actor: Actor, id: string, input: PurchaseInput, revision: number) {
      return db.transaction((tx) => {
        const row = tx.select().from(purchaseRequests).where(eq(purchaseRequests.id, id)).get()
        if (!row || (row.requestedBy !== actor.id && !actor.canManage)) return "missing"
        if (!draftActions(row, actor).edit) return "invalid_transition"
        if (row.revision !== revision) return "stale_purchase"
        if (!validReferences(tx, input)) return "invalid_purchase_reference"
        const previous = tx.select({ total: count() }).from(purchaseRequestItems)
          .where(eq(purchaseRequestItems.requestId, id)).get()?.total ?? 0
        const { items, ...fields } = input
        tx.update(purchaseRequests).set({ ...fields, revision: revision + 1 }).where(eq(purchaseRequests.id, id)).run()
        tx.delete(purchaseRequestItems).where(eq(purchaseRequestItems.requestId, id)).run()
        insertItems(tx, id, items)
        audit(tx, actor, id, "purchase_updated", snapshot(row, previous, revision), snapshot(fields, items.length, revision + 1))
        return "saved"
      }, { behavior: "immediate" })
    },

    transition(actor: Actor, id: string, next: PurchaseStatus, revision: number) {
      return db.transaction((tx) => {
        const row = tx.select().from(purchaseRequests).where(eq(purchaseRequests.id, id)).get()
        if (!row || (row.requestedBy !== actor.id && !actor.canManage)) return "missing"
        if (next === "submitted" && row.status === next && row.revision === revision + 1) return "saved"
        if (next !== "submitted" || !draftActions(row, actor).submit) return "invalid_transition"
        if (row.revision !== revision) return "stale_purchase"
        const items = tx.select({ materialId: purchaseRequestItems.materialId, quantity: purchaseRequestItems.quantity })
          .from(purchaseRequestItems).where(eq(purchaseRequestItems.requestId, id)).all()
        if (!validReferences(tx, { ...row, items })) return "invalid_purchase_reference"
        tx.update(purchaseRequests).set({ status: next, submittedAt: now(), revision: revision + 1 })
          .where(eq(purchaseRequests.id, id)).run()
        audit(tx, actor, id, "purchase_submitted", { status: row.status, revision }, { status: next, revision: revision + 1 })
        return "saved"
      }, { behavior: "immediate" })
    },

    decide(actor: Actor, id: string, decision: PurchaseDecision) {
      if (!actor.canApprove || !actor.canViewCosts) return "missing"
      return db.transaction((tx) => {
        const row = tx.select().from(purchaseRequests).where(eq(purchaseRequests.id, id)).get()
        if (!row) return "missing"
        if (!canTransition(row.status, decision.status)) return "invalid_transition"
        if (row.revision !== decision.revision) return "stale_purchase"
        const items = tx.select().from(purchaseRequestItems).where(eq(purchaseRequestItems.requestId, id)).all()
        if (decision.status === "approved" || decision.status === "ordered") {
          if (!validReferences(tx, { ...row, items })) return "invalid_purchase_reference"
          if (decision.prices && !writePrices(tx, items.map(({ id }) => id), decision.prices)) return "invalid_price_items"
          if (decision.status === "ordered" && pricesFor(tx, id).length !== items.length) return "prices_required"
        }
        const nextRevision = row.revision + 1
        const occurredAt = now()
        tx.update(purchaseRequests).set({
          status: decision.status, revision: nextRevision,
          decisionReason: "reason" in decision ? decision.reason : null,
          orderedAt: decision.status === "ordered" ? occurredAt : row.orderedAt,
        }).where(eq(purchaseRequests.id, id)).run()
        if (decision.status === "ordered" || row.status === "ordered") {
          refreshMaterialCosts(tx, items.map(({ materialId }) => materialId))
        }
        audit(tx, actor, id, `purchase_${decision.status}`, { status: row.status, revision: row.revision },
          { status: decision.status, revision: nextRevision })
        return "saved"
      }, { behavior: "immediate" })
    },

    receive(actor: Actor, id: string, receipt: PurchaseReceipt) {
      return db.transaction((tx) => {
        const row = tx.select().from(purchaseRequests).where(eq(purchaseRequests.id, id)).get()
        if (!row || (!actor.canApprove && row.requestedBy !== actor.id)) return "missing"
        if (row.revision !== receipt.revision) {
          const previous = tx.select({ itemId: stockMovements.referenceItemId, quantity: stockMovements.quantity })
            .from(stockMovements).where(and(eq(stockMovements.referenceId, id), eq(stockMovements.kind, "purchase_receipt"),
              eq(stockMovements.referenceRevision, receipt.revision))).all()
          const quantities = new Map(previous.map(({ itemId, quantity }) => [itemId, quantity]))
          return previous.length === receipt.items.length && receipt.items.every(({ itemId, quantity }) =>
            quantities.get(itemId) === new Quantity(quantity).toFixed()) ? "saved" : "stale_purchase"
        }
        if (!canReceive(row, actor)) return "invalid_transition"
        const items = tx.select().from(purchaseRequestItems).where(eq(purchaseRequestItems.requestId, id)).all()
        const byId = new Map(items.map((item) => [item.id, item]))
        const totals = new Map<string, InstanceType<typeof Quantity>>()
        const movements: (typeof stockMovements.$inferInsert)[] = []
        const occurredAt = now()
        for (const line of receipt.items) {
          const item = byId.get(line.itemId)
          if (!item) return "invalid_receipt"
          const delta = new Quantity(line.quantity)
          const total = delta.plus(item.receivedExact)
          if (total.lte(item.receivedExact) || total.gt(item.quantity)) return "invalid_receipt"
          totals.set(item.id, total)
          const material = tx.select({ mergedIntoId: materials.mergedIntoId }).from(materials).where(eq(materials.id, item.materialId)).get()
          movements.push({
            id: randomUUID(), branchId: row.branchId, materialId: material?.mergedIntoId ?? item.materialId, quantity: delta.toFixed(),
            kind: "purchase_receipt", referenceId: id, referenceItemId: item.id, referenceRevision: row.revision, occurredAt,
          })
        }
        const next = items.every((item) => (totals.get(item.id) ?? new Quantity(item.receivedExact)).eq(item.quantity))
          ? "received" : "partially_received"
        if (!canTransition(row.status, next)) return "invalid_transition"
        for (const [itemId, total] of totals) {
          tx.update(purchaseRequestItems).set({ receivedExact: total.toFixed(), receivedQuantity: total.toNumber() })
            .where(eq(purchaseRequestItems.id, itemId)).run()
        }
        tx.insert(stockMovements).values(movements).run()
        tx.update(purchaseRequests).set({ status: next, revision: row.revision + 1 }).where(eq(purchaseRequests.id, id)).run()
        audit(tx, actor, id, "purchase_receipt", { status: row.status, revision: row.revision },
          { status: next, revision: row.revision + 1, itemCount: movements.length })
        return "saved"
      }, { behavior: "immediate" })
    },
  }
}
