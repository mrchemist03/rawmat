import { z } from "zod"
import { listQuerySchema } from "./management.js"

export const purchaseStatus = z.enum([
  "draft", "submitted", "approved", "rejected", "ordered", "partially_received", "received", "cancelled",
])

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
  items: z.array(z.strictObject({
    materialId: z.uuid(), name: z.string(), code: z.string(), unitName: z.string(),
    quantity: z.number(), archived: z.boolean(),
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
