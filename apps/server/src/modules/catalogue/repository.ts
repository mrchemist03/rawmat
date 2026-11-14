import { randomUUID } from "node:crypto"
import { and, asc, count, desc, eq, sql } from "drizzle-orm"
import { pageSize } from "@rawmat/shared"
import type { LookupKind, MaterialInput, MaterialQuery, SimilarityReport, SupplierInput } from "@rawmat/shared"
import type { AppDatabase } from "../../db/database.js"
import { auditLog, categories, materials, suppliers, units } from "../../db/schema.js"
import { normalizeMaterialName, similarityIndex } from "./similarity.js"
import type { SimilarityThresholds } from "./similarity.js"
import type { CsvRow } from "./csv.js"

const lookupTables = { categories, units, suppliers }
const sortColumns = { name: materials.name, code: materials.code, category: categories.name, minimum: materials.minimumQuantity }
const materialFields = {
  id: materials.id, code: materials.code, name: materials.name, categoryId: materials.categoryId,
  categoryName: categories.name, unitId: materials.unitId, unitName: units.name,
  supplierId: materials.supplierId, supplierName: suppliers.name,
  minimumQuantity: materials.minimumQuantity, notes: materials.notes, archived: materials.archived,
  mergedIntoId: materials.mergedIntoId,
}

type CatalogueConnection = Pick<AppDatabase, "select" | "insert" | "update">
type Snapshot = typeof auditLog.$inferInsert.before
type Review = { confirm?: boolean; canOverride: boolean }
type WriteResult = "saved" | "missing" | "invalid_reference" | "invalid_name" | { similarity: SimilarityReport }

export function createCatalogueRepository(db: AppDatabase, now: () => number, thresholds: SimilarityThresholds) {
  function audit(tx: Pick<AppDatabase, "insert">, actorId: string, action: string, entity: string, entityId: string,
    before?: Snapshot, after?: Snapshot) {
    tx.insert(auditLog).values({ id: randomUUID(), actorId, action, entity, entityId, occurredAt: now(), before, after }).run()
  }

  function buildIndex(tx: Pick<AppDatabase, "select">) {
    return similarityIndex(tx.select({
      id: materials.id, name: materials.name, code: materials.code, unitId: materials.unitId,
      nameNormalized: materials.nameNormalized, archived: materials.archived,
    }).from(materials).where(sql`${materials.mergedIntoId} is null`)
      .orderBy(asc(materials.archived), asc(materials.legacyDuplicate), asc(materials.id)).all(), thresholds)
  }

  function compactMaterial(input: MaterialInput) {
    const { name, categoryId, unitId, supplierId, minimumQuantity } = input
    return { name, categoryId, unitId, supplierId, minimumQuantity }
  }

  function writeMaterial(tx: CatalogueConnection, index: ReturnType<typeof buildIndex>, actorId: string,
    input: MaterialInput, review: Review, id?: string, preview = false, validateReferences = true): WriteResult {
    const original = id ? tx.select().from(materials)
      .where(and(eq(materials.id, id), eq(materials.archived, false))).get() : undefined
    if (id && !original) return "missing"
    const normalized = normalizeMaterialName(input.name)
    if (!normalized) return "invalid_name"
    if (validateReferences) {
      const category = tx.select({ id: categories.id }).from(categories).where(eq(categories.id, input.categoryId)).get()
      const unit = tx.select({ id: units.id }).from(units).where(eq(units.id, input.unitId)).get()
      const supplier = !input.supplierId || tx.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, input.supplierId)).get()
      if (!category || !unit || !supplier) return "invalid_reference"
    }
    const unchanged = original?.nameNormalized === normalized && original.unitId === input.unitId
    const report = unchanged ? undefined : index.check(normalized, input.unitId, id)
    if (report && (report.level === "exact" ||
      (report.level === "high" && (!review.canOverride || !review.confirm)) ||
      (report.level === "warning" && !review.confirm))) return { similarity: report }

    const materialId = id ?? randomUUID()
    const code = original?.code ?? `MAT-${materialId.replaceAll("-", "").toUpperCase()}`
    const values = { ...input, nameNormalized: normalized, legacyDuplicate: unchanged && Boolean(original?.legacyDuplicate) }
    if (!preview) {
      if (id) tx.update(materials).set(values).where(eq(materials.id, id)).run()
      else tx.insert(materials).values({ ...values, id: materialId, code }).run()
      audit(tx, actorId, id ? "material_updated" : "material_created", "material", materialId,
        original && compactMaterial(original), compactMaterial(input))
      if (report?.level === "high" || report?.level === "warning") {
        audit(tx, actorId, "material_similarity_confirmed", "material", materialId, undefined,
          { level: report.level, matchedId: report.matches[0]?.id ?? null, score: report.matches[0]?.score ?? 0 })
      }
    }
    if (!id) index.add({ id: materialId, code, name: input.name, nameNormalized: normalized, unitId: input.unitId, archived: false })
    return "saved"
  }

  return {
    listMaterials({ search = "", page = 1, sort = "name", direction = "asc", status = "active", id }: MaterialQuery) {
      const term = search.toLowerCase()
      const matches = sql`instr(lower(${materials.name}), ${term}) > 0 or instr(lower(${materials.code}), ${term}) > 0`
      const filter = and(matches, id ? eq(materials.id, id) : undefined,
        status === "all" ? undefined : eq(materials.archived, status === "archived"))
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

    checkSimilarity(name: string, unitId: string, exclude?: string) {
      const normalized = normalizeMaterialName(name)
      return normalized ? buildIndex(db).check(normalized, unitId, exclude) : undefined
    },

    saveMaterial(actorId: string, input: MaterialInput, review: Review, id?: string) {
      return db.transaction((tx) => writeMaterial(tx, buildIndex(tx), actorId, input, review, id), { behavior: "immediate" })
    },

    importMaterials(actorId: string, rows: { row: number; input?: CsvRow }[], review: Review, preview: boolean) {
      return db.transaction((tx) => {
        const index = buildIndex(tx)
        const referenceIds = (table: typeof categories | typeof units | typeof suppliers) =>
          new Map(tx.select({ id: table.id, name: table.name }).from(table).all().map(({ id, name }) => [name, id]))
        const categoryIds = referenceIds(categories)
        const unitIds = referenceIds(units)
        const supplierIds = referenceIds(suppliers)
        const issues: { row: number; reason: string; similarity?: SimilarityReport }[] = []
        let accepted = 0
        for (const { row, input } of rows) {
          let result: WriteResult | "invalid_input" = "invalid_input"
          if (input) {
            const { category, unit, supplier, ...fields } = input
            const categoryId = categoryIds.get(category)
            const unitId = unitIds.get(unit)
            const supplierId = supplier ? supplierIds.get(supplier) : null
            result = categoryId && unitId && supplierId !== undefined
              ? writeMaterial(tx, index, actorId, { ...fields, categoryId, unitId, supplierId }, review, undefined, preview, false)
              : "invalid_reference"
          }
          if (result === "saved") accepted++
          else if (issues.length < 100) issues.push(typeof result === "string" ? { row, reason: result } :
            { row, reason: "similarity", similarity: result.similarity })
        }
        if (!preview && accepted) audit(tx, actorId, "material_import", "material", randomUUID(), undefined,
          { accepted, skipped: rows.length - accepted })
        return { accepted, skipped: rows.length - accepted, issues }
      }, { behavior: preview ? "deferred" : "immediate" })
    },

    mergeMaterials(actorId: string, sourceId: string, targetId: string) {
      return db.transaction((tx) => {
        if (sourceId === targetId) return "invalid_merge"
        const source = tx.select().from(materials).where(eq(materials.id, sourceId)).get()
        const target = tx.select().from(materials).where(eq(materials.id, targetId)).get()
        if (!source || !target) return "missing"
        if (source.mergedIntoId === targetId) return "saved"
        if (source.mergedIntoId || target.archived || source.unitId !== target.unitId) return "invalid_merge"
        tx.update(materials).set({ archived: true, mergedIntoId: targetId }).where(eq(materials.id, sourceId)).run()
        tx.update(materials).set({ mergedIntoId: targetId }).where(eq(materials.mergedIntoId, sourceId)).run()
        audit(tx, actorId, "materials_merged", "material", sourceId,
          { name: source.name, code: source.code, archived: source.archived }, { archived: true, mergedIntoId: targetId, targetCode: target.code })
        return "saved"
      }, { behavior: "immediate" })
    },

    archiveMaterial(actorId: string, id: string, archived: boolean) {
      return db.transaction((tx) => {
        const current = tx.select({ archived: materials.archived, mergedIntoId: materials.mergedIntoId })
          .from(materials).where(eq(materials.id, id)).get()
        if (!current) return "missing"
        if (current.mergedIntoId) return "invalid_merge"
        if (current.archived === archived) return "saved"
        tx.update(materials).set({ archived }).where(eq(materials.id, id)).run()
        audit(tx, actorId, archived ? "material_archived" : "material_restored", "material", id,
          { archived: current.archived }, { archived })
        return "saved"
      }, { behavior: "immediate" })
    },

    saveReference(actorId: string, kind: LookupKind, input: { name: string } | SupplierInput, id?: string) {
      const table = lookupTables[kind]
      return db.transaction((tx) => {
        const original = id ? tx.select({ name: table.name }).from(table).where(eq(table.id, id)).get() : undefined
        if (id && !original) return "missing"
        const existing = tx.select({ id: table.id }).from(table)
          .where(sql`lower(${table.name}) = lower(${input.name})`).get()
        if (existing && existing.id !== id) return "duplicate"
        const referenceId = id ?? randomUUID()
        if (id) tx.update(table).set(input).where(eq(table.id, id)).run()
        else tx.insert(table).values({ id: referenceId, ...input }).run()
        audit(tx, actorId, id ? "reference_updated" : "reference_created", kind, referenceId, original, { name: input.name })
        return "saved"
      }, { behavior: "immediate" })
    },
  }
}
