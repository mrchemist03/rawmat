import { z } from "zod"
import { listQuerySchema } from "./management.js"

export const purchaseStatus = z.enum([
  "draft", "submitted", "approved", "rejected", "ordered", "partially_received", "received", "cancelled",
])
export const purchaseStatusLabels: Record<z.infer<typeof purchaseStatus>, string> = {
  draft: "مسودة", submitted: "مُرسل", approved: "معتمد", rejected: "مرفوض",
  ordered: "تم الطلب", partially_received: "مُستلم جزئيًا", received: "مُستلم", cancelled: "ملغى",
}

export const purchaseInputSchema = z.strictObject({
  branchId: z.uuid(),
  neededOn: z.iso.date(),
  supplierId: z.uuid().nullable(),
  notes: z.string().trim().max(2_000),
  items: z.array(z.strictObject({
    materialId: z.uuid(),
    quantity: z.number().positive().max(1_000_000_000),
  })).min(1).max(100).refine((items) => new Set(items.map(({ materialId }) => materialId)).size === items.length),
})
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
export const purchaseUpdateSchema = purchaseInputSchema.extend({ revision })
export const purchaseTransitionSchema = z.strictObject({ status: purchaseStatus, revision })
export const purchaseCurrencySchema = z.string().trim().toUpperCase().refine((code) => currencies.has(code))
const currencies = new Set(Intl.supportedValuesOf("currency"))
export function currencyDigits(currency: string) {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2
}

export function formatMinor(minor: string | number, currency: string) {
  const digits = currencyDigits(currency)
  const value = String(minor).padStart(digits + 1, "0")
  return digits ? value.slice(0, -digits) + "." + value.slice(-digits) : value
}
const unitPrice = z.strictObject({
  itemId: z.uuid(), unitPriceMinor: z.number().int().min(0).max(1_000_000_000_000), currency: purchaseCurrencySchema,
})
const priceLines = z.array(unitPrice).min(1).max(100)
  .refine((items) => new Set(items.map(({ itemId }) => itemId)).size === items.length)
export const purchaseDecisionSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("approved"), revision, prices: priceLines.optional() }),
  z.strictObject({ status: z.literal("rejected"), revision, reason: z.string().trim().min(1).max(500) }),
  z.strictObject({ status: z.literal("ordered"), revision, prices: priceLines.optional() }),
  z.strictObject({ status: z.literal("cancelled"), revision, reason: z.string().trim().min(1).max(500) }),
])
export const purchaseReceiptSchema = z.strictObject({
  revision,
  items: z.array(z.strictObject({ itemId: z.uuid(), quantity: z.union([
    z.number().positive().max(1_000_000_000),
    z.string().max(338).regex(/^\d{1,10}(?:\.\d{1,325})?$/)
      .refine((value) => Number(value) > 0 && Number(value) <= 1_000_000_000),
  ]) }))
    .min(1).max(100).refine((items) => new Set(items.map(({ itemId }) => itemId)).size === items.length),
})
export const purchaseCostsSchema = z.strictObject({
  defaultCurrency: purchaseCurrencySchema,
  items: z.array(unitPrice),
  totals: z.array(z.strictObject({ currency: purchaseCurrencySchema, totalMinor: z.string().regex(/^\d+$/) })),
})

export const purchaseQuerySchema = listQuerySchema.extend({
  status: purchaseStatus.optional(),
  sort: z.enum(["newest", "neededOn"]).optional(),
})
export const purchaseSummarySchema = z.strictObject({
  id: z.uuid(), number: z.string(), branchId: z.uuid(), branchName: z.string(),
  requesterName: z.string(), supplierId: z.uuid().nullable(), supplierName: z.string().nullable(),
  neededOn: z.iso.date(), status: purchaseStatus, createdAt: z.number().int(),
  actions: z.strictObject({ edit: z.boolean(), submit: z.boolean() }),
})
export const purchaseDetailSchema = purchaseSummarySchema.extend({
  notes: z.string(), revision,
  decisionReason: z.string().nullable(),
  workflow: z.strictObject({
    approve: z.boolean(), reject: z.boolean(), order: z.boolean(), receive: z.boolean(), cancel: z.boolean(),
    viewCosts: z.literal(true).optional(),
  }),
  items: z.array(z.strictObject({
    id: z.uuid(), materialId: z.uuid(), name: z.string(), code: z.string(), unitName: z.string(),
    quantity: z.number(), receivedQuantity: z.number(), remainingQuantity: z.number(),
    remainingExact: z.string().regex(/^\d+(?:\.\d+)?$/), archived: z.boolean(),
  })),
})
export const purchaseListSchema = z.strictObject({ items: z.array(purchaseSummarySchema), total: z.number().int() })
export const purchaseBranchListSchema = z.strictObject({
  items: z.array(z.strictObject({ id: z.uuid(), name: z.string() })), total: z.number().int(),
})
export const purchaseIdSchema = z.strictObject({ id: z.uuid() })

export type PurchaseInput = z.infer<typeof purchaseInputSchema>
export type PurchaseQuery = z.infer<typeof purchaseQuerySchema>
export type PurchaseStatus = z.infer<typeof purchaseStatus>
export type PurchaseDetail = z.infer<typeof purchaseDetailSchema>
export type PurchaseDecision = z.infer<typeof purchaseDecisionSchema>
export type PurchaseReceipt = z.infer<typeof purchaseReceiptSchema>
export type PurchaseCosts = z.infer<typeof purchaseCostsSchema>
