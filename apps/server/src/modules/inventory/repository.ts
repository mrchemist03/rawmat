import { asc, eq, inArray, or } from "drizzle-orm"
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
