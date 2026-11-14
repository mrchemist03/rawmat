import { randomUUID } from "node:crypto"
import { and, asc, count, desc, eq, sql } from "drizzle-orm"
import { pageSize } from "@rawmat/shared"
import type { LookupKind, MaterialInput, MaterialQuery, SupplierInput } from "@rawmat/shared"
import type { AppDatabase } from "../../db/database.js"
import { auditLog, categories, materials, suppliers, units } from "../../db/schema.js"

const lookupTables = { categories, units, suppliers }
const sortColumns = { name: materials.name, code: materials.code, category: categories.name, minimum: materials.minimumQuantity }
const materialFields = {
  id: materials.id, code: materials.code, name: materials.name, categoryId: materials.categoryId,
  categoryName: categories.name, unitId: materials.unitId, unitName: units.name,
  supplierId: materials.supplierId, supplierName: suppliers.name,
  minimumQuantity: materials.minimumQuantity, notes: materials.notes, archived: materials.archived,
}

export function createCatalogueRepository(db: AppDatabase, now: () => number) {
  function audit(tx: Pick<AppDatabase, "insert">, actorId: string, action: string, entity: string, entityId: string) {
    tx.insert(auditLog).values({ id: randomUUID(), actorId, action, entity, entityId, occurredAt: now() }).run()
  }

  return {
    listMaterials({ search = "", page = 1, sort = "name", direction = "asc", status = "active" }: MaterialQuery) {
      const term = search.toLowerCase()
      const matches = sql`instr(lower(${materials.name}), ${term}) > 0 or instr(lower(${materials.code}), ${term}) > 0`
      const filter = and(matches, status === "all" ? undefined : eq(materials.archived, status === "archived"))
      const items = db.select(materialFields).from(materials)
        .innerJoin(categories, eq(categories.id, materials.categoryId))
        .innerJoin(units, eq(units.id, materials.unitId))
        .leftJoin(suppliers, eq(suppliers.id, materials.supplierId))
        .where(filter).orderBy((direction === "desc" ? desc : asc)(sortColumns[sort]), asc(materials.id))
        .limit(pageSize).offset((page - 1) * pageSize).all()
      const total = db.select({ value: count() }).from(materials).where(filter).get()?.value ?? 0
      return { items, total }
    },

    listReferences(kind: LookupKind, search: string, page: number, details: boolean) {
      const table = lookupTables[kind]
      const filter = sql`instr(lower(${table.name}), ${search.toLowerCase()}) > 0`
      const fields = { id: table.id, name: table.name }
      const total = db.select({ value: count() }).from(table).where(filter).get()?.value ?? 0
      const offset = (page - 1) * pageSize
      const items = kind === "suppliers" && details
        ? db.select({ ...fields, contact: suppliers.contact, notes: suppliers.notes }).from(suppliers)
          .where(filter).orderBy(asc(suppliers.name), asc(suppliers.id)).limit(pageSize).offset(offset).all()
        : db.select(fields).from(table).where(filter).orderBy(asc(table.name), asc(table.id))
          .limit(pageSize).offset(offset).all()
      return { items, total }
    },

    saveMaterial(actorId: string, input: MaterialInput, id?: string) {
      return db.transaction((tx) => {
        if (id && !tx.select({ id: materials.id }).from(materials)
          .where(and(eq(materials.id, id), eq(materials.archived, false))).get()) return "missing"
        const category = tx.select({ id: categories.id }).from(categories).where(eq(categories.id, input.categoryId)).get()
        const unit = tx.select({ id: units.id }).from(units).where(eq(units.id, input.unitId)).get()
        const supplierOK = !input.supplierId || tx.select({ id: suppliers.id }).from(suppliers)
          .where(eq(suppliers.id, input.supplierId)).get()
        if (!category || !unit || !supplierOK) return "invalid_reference"

        const materialId = id ?? randomUUID()
        if (id) tx.update(materials).set(input).where(eq(materials.id, id)).run()
        else tx.insert(materials).values({ ...input, id: materialId, code: `MAT-${materialId.replaceAll("-", "").toUpperCase()}` }).run()
        audit(tx, actorId, id ? "material_updated" : "material_created", "material", materialId)
        return "saved"
      }, { behavior: "immediate" })
    },

    archiveMaterial(actorId: string, id: string, archived: boolean) {
      return db.transaction((tx) => {
        const current = tx.select({ archived: materials.archived }).from(materials).where(eq(materials.id, id)).get()
        if (!current) return "missing"
        if (current.archived === archived) return "saved"
        tx.update(materials).set({ archived }).where(eq(materials.id, id)).run()
        audit(tx, actorId, archived ? "material_archived" : "material_restored", "material", id)
        return "saved"
      }, { behavior: "immediate" })
    },

    saveReference(actorId: string, kind: LookupKind, input: { name: string } | SupplierInput, id?: string) {
      const table = lookupTables[kind]
      return db.transaction((tx) => {
        if (id && !tx.select({ id: table.id }).from(table).where(eq(table.id, id)).get()) return "missing"
        const existing = tx.select({ id: table.id }).from(table)
          .where(sql`lower(${table.name}) = lower(${input.name})`).get()
        if (existing && existing.id !== id) return "duplicate"
        const referenceId = id ?? randomUUID()
        if (id) tx.update(table).set(input).where(eq(table.id, id)).run()
        else tx.insert(table).values({ id: referenceId, ...input }).run()
        audit(tx, actorId, id ? "reference_updated" : "reference_created", kind, referenceId)
        return "saved"
      }, { behavior: "immediate" })
    },
  }
}
