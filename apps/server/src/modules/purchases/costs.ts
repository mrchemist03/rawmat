import { and, eq, gte, inArray, lt, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import type { Decimal } from "decimal.js"
import type { PurchaseDecision } from "@rawmat/shared"
import type { AppDatabase } from "../../db/database.js"
import { materialCosts, materials, purchaseItemCosts, purchaseRequestItems, purchaseRequests } from "../../db/schema.js"
import { Quantity } from "../inventory/quantity.js"

type Connection = Pick<AppDatabase, "select" | "insert" | "delete">
type Prices = Extract<PurchaseDecision, { status: "approved" }>["prices"]

function lineTotal(unitPriceMinor: number, quantity: number) {
  return new Quantity(unitPriceMinor).times(quantity).toDecimalPlaces(0)
}

export function pricesFor(db: Connection, requestId: string) {
  return db.select({
    itemId: purchaseItemCosts.itemId, unitPriceMinor: purchaseItemCosts.unitPriceMinor,
    currency: purchaseItemCosts.currency, quantity: purchaseRequestItems.quantity,
  }).from(purchaseItemCosts).innerJoin(purchaseRequestItems, eq(purchaseItemCosts.itemId, purchaseRequestItems.id))
    .where(eq(purchaseRequestItems.requestId, requestId)).all()
}

export function readPurchaseCosts(db: Connection, requestId: string, defaultCurrency: string) {
  const totalByCurrency = new Map<string, Decimal>()
  const items = pricesFor(db, requestId).map(({ quantity, ...price }) => {
    const total = lineTotal(price.unitPriceMinor, quantity)
    totalByCurrency.set(price.currency, (totalByCurrency.get(price.currency) ?? new Quantity(0)).plus(total))
    return price
  })
  const totals = [...totalByCurrency].sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, total]) => ({ currency, totalMinor: total.toFixed(0) }))
  return { defaultCurrency, items, totals }
}

export function readMonthlySpending(db: Pick<AppDatabase, "select">, start: number, end: number) {
  const target = alias(materials, "spending_material")
  const rows = db.select({ id: target.id, name: target.name, quantity: purchaseRequestItems.quantity,
    unitPriceMinor: purchaseItemCosts.unitPriceMinor, currency: purchaseItemCosts.currency }).from(purchaseItemCosts)
    .innerJoin(purchaseRequestItems, eq(purchaseItemCosts.itemId, purchaseRequestItems.id))
    .innerJoin(purchaseRequests, eq(purchaseRequests.id, purchaseRequestItems.requestId))
    .innerJoin(materials, eq(materials.id, purchaseRequestItems.materialId))
    .innerJoin(target, eq(target.id, sql`coalesce(${materials.mergedIntoId}, ${materials.id})`))
    .where(and(gte(purchaseRequests.orderedAt, start), lt(purchaseRequests.orderedAt, end),
      inArray(purchaseRequests.status, ["ordered", "partially_received", "received"]))).all()
  type MaterialSpend = { id: string; name: string; amount: Decimal }
  const currencies = new Map<string, { total: Decimal; materials: Map<string, MaterialSpend> }>()
  for (const { id, name, quantity, currency, unitPriceMinor } of rows) {
    const entry = currencies.get(currency) ?? { total: new Quantity(0), materials: new Map<string, MaterialSpend>() }
    const amount = lineTotal(unitPriceMinor, quantity)
    entry.total = entry.total.plus(amount)
    entry.materials.set(id, { id, name, amount: amount.plus(entry.materials.get(id)?.amount ?? 0) })
    currencies.set(currency, entry)
  }
  return [...currencies].sort(([a], [b]) => a.localeCompare(b)).map(([currency, entry]) => ({
    currency, totalMinor: entry.total.toFixed(0),
    materials: [...entry.materials.values()]
      .sort((a, b) => b.amount.cmp(a.amount) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .slice(0, 5).map(({ id, name, amount }) => ({ id, name, amountMinor: amount.toFixed(0) })),
  }))
}

export function writePrices(tx: Connection, ids: string[], prices: NonNullable<Prices>) {
  const items = new Set(ids)
  if (prices.length !== items.size || prices.some(({ itemId }) => !items.has(itemId))) return false
  tx.insert(purchaseItemCosts).values(prices).onConflictDoUpdate({
    target: purchaseItemCosts.itemId,
    set: { unitPriceMinor: sql`excluded.unit_price_minor`, currency: sql`excluded.currency` },
  }).run()
  return true
}

export function refreshMaterialCosts(tx: Connection, materialIds: string[]) {
  if (!materialIds.length) return
  const rows = tx.select({
    materialId: purchaseRequestItems.materialId, quantity: purchaseRequestItems.quantity,
    unitPriceMinor: purchaseItemCosts.unitPriceMinor, currency: purchaseItemCosts.currency,
  }).from(purchaseItemCosts).innerJoin(purchaseRequestItems, eq(purchaseItemCosts.itemId, purchaseRequestItems.id))
    .innerJoin(purchaseRequests, eq(purchaseRequests.id, purchaseRequestItems.requestId))
    .where(and(inArray(purchaseRequestItems.materialId, materialIds),
      inArray(purchaseRequests.status, ["ordered", "partially_received", "received"])))
    .orderBy(purchaseRequests.orderedAt, purchaseRequests.id).all()

  const summary = new Map<string, {
    materialId: string; currency: string; lastUnitPriceMinor: number; quantity: Decimal; weighted: Decimal
  }>()
  for (const { materialId, currency, unitPriceMinor, quantity } of rows) {
    const key = `${materialId}:${currency}`
    const previous = summary.get(key)
    const weighted = new Quantity(unitPriceMinor).times(quantity).plus(previous?.weighted ?? 0)
    summary.set(key, { materialId, currency, lastUnitPriceMinor: unitPriceMinor,
      weighted, quantity: new Quantity(quantity).plus(previous?.quantity ?? 0) })
  }
  tx.delete(materialCosts).where(inArray(materialCosts.materialId, materialIds)).run()
  for (const { quantity, weighted, ...row } of summary.values()) {
    tx.insert(materialCosts).values({ ...row, averageUnitPriceMinor: weighted.div(quantity).toDecimalPlaces(0).toNumber() }).run()
  }
}
