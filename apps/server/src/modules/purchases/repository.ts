import { randomUUID } from "node:crypto"
import { pageSize } from "@rawmat/shared"
import type { PurchaseInput, PurchaseQuery, PurchaseStatus } from "@rawmat/shared"
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm"
import type { AppDatabase } from "../../db/database.js"
import { auditLog, branches, materials, purchaseRequestItems, purchaseRequests, suppliers, units, users } from "../../db/schema.js"
import { canTransition } from "./workflow.js"

type Actor = { id: string; canCreate: boolean; canManage: boolean }
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
      }).from(purchaseRequests).innerJoin(branches, eq(purchaseRequests.branchId, branches.id))
        .innerJoin(users, eq(purchaseRequests.requestedBy, users.id))
        .leftJoin(suppliers, eq(purchaseRequests.supplierId, suppliers.id)).where(eq(purchaseRequests.id, id)).get()
      if (!row) return
      const items = db.select({
        materialId: materials.id, name: materials.name, code: materials.code, unitName: units.name,
        quantity: purchaseRequestItems.quantity, archived: materials.archived,
      }).from(purchaseRequestItems).innerJoin(materials, eq(purchaseRequestItems.materialId, materials.id))
        .innerJoin(units, eq(materials.unitId, units.id)).where(eq(purchaseRequestItems.requestId, id))
        .orderBy(asc(purchaseRequestItems.position)).all()
      const { requestedBy, ...details } = row
      return { ...details, items, actions: draftActions({ ...details, requestedBy }, actor) }
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
        if (!draftActions(row, actor).submit || !canTransition(row.status, next)) return "invalid_transition"
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
  }
}
