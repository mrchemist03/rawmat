import { and, asc, count, eq, inArray, or, sql } from "drizzle-orm"
import { pageSize } from "@rawmat/shared"
import type { AppDatabase } from "../../db/database.js"
import { branches, materials, stockMovements } from "../../db/schema.js"
import { Quantity } from "./quantity.js"

export function materialBalances(db: AppDatabase, materialId: string, page: number) {
  const material = db.select({ mergedIntoId: materials.mergedIntoId }).from(materials).where(eq(materials.id, materialId)).get()
  if (!material) return
  const target = material.mergedIntoId ?? materialId
  const sources = db.select({ id: materials.id }).from(materials).where(eq(materials.mergedIntoId, target))
  const balances = new Map<string, { branchId: string; branchName: string; quantity: InstanceType<typeof Quantity> }>()
  const rows = db.select({ branchId: branches.id, branchName: branches.name, quantity: stockMovements.quantity })
    .from(stockMovements).innerJoin(branches, eq(branches.id, stockMovements.branchId))
    .where(or(eq(stockMovements.materialId, target), inArray(stockMovements.materialId, sources)))
    .orderBy(asc(branches.name), asc(branches.id)).all()
  for (const { branchId, branchName, quantity } of rows) {
    balances.set(branchId, { branchId, branchName, quantity: new Quantity(quantity).plus(balances.get(branchId)?.quantity ?? 0) })
  }
  return {
    items: [...balances.values()].slice((page - 1) * pageSize, page * pageSize)
      .map(({ quantity, ...row }) => ({ ...row, quantity: quantity.toFixed() })),
    total: balances.size,
  }
}

export function branchBalance(db: Pick<AppDatabase, "select">, materialId: string, branchId: string) {
  const sources = db.select({ id: materials.id }).from(materials).where(eq(materials.mergedIntoId, materialId))
  const rows = db.select({ quantity: stockMovements.quantity }).from(stockMovements)
    .where(and(eq(stockMovements.branchId, branchId),
      or(eq(stockMovements.materialId, materialId), inArray(stockMovements.materialId, sources)))).all()
  return rows.reduce((balance, row) => balance.plus(row.quantity), new Quantity(0))
}

export function countLowStock(db: Pick<AppDatabase, "select">) {
  const below = db.select({ id: materials.id, minimum: materials.minimumQuantity }).from(materials)
    .where(and(eq(materials.archived, false), sql`${materials.minimumQuantity} > 0`)).all()
  if (!below.length) return 0
  const target = sql<string>`coalesce(${materials.mergedIntoId}, ${materials.id})`
  const limited = db.select({ id: materials.id }).from(materials)
    .where(and(eq(materials.archived, false), sql`${materials.minimumQuantity} > 0`))
  const quantities = db.select({ materialId: target, quantity: stockMovements.quantity }).from(stockMovements)
    .innerJoin(branches, eq(stockMovements.branchId, branches.id))
    .innerJoin(materials, eq(stockMovements.materialId, materials.id))
    .where(and(eq(branches.active, true), inArray(target, limited))).all()
  const stock = new Map<string, InstanceType<typeof Quantity>>()
  for (const { materialId, quantity } of quantities) {
    stock.set(materialId, (stock.get(materialId) ?? new Quantity(0)).plus(quantity))
  }
  return below.filter(({ id, minimum }) => (stock.get(id) ?? new Quantity(0)).lt(minimum)).length
}

export function listActiveBranches(db: Pick<AppDatabase, "select">, search: string, page: number) {
  const filter = and(eq(branches.active, true),
    search ? sql`instr(lower(${branches.name}), ${search.toLowerCase()}) > 0` : undefined)
  const items = db.select({ id: branches.id, name: branches.name }).from(branches).where(filter)
    .orderBy(asc(branches.name), asc(branches.id)).limit(pageSize).offset((page - 1) * pageSize).all()
  return { items, total: db.select({ total: count() }).from(branches).where(filter).get()?.total ?? 0 }
}
