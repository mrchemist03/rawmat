import { z } from "zod"
import { listQuerySchema } from "./management.js"

export const lookupKindSchema = z.enum(["categories", "units", "suppliers"])
export const referenceInputSchema = z.strictObject({ name: z.string().trim().min(1).max(120) })
export const supplierInputSchema = referenceInputSchema.extend({
  contact: z.string().trim().max(250),
  notes: z.string().trim().max(2_000),
})
export const referenceOptionSchema = z.strictObject({ id: z.uuid(), name: z.string() })
export const referenceListSchema = z.strictObject({ items: z.array(referenceOptionSchema), total: z.number().int() })
export const supplierListSchema = referenceListSchema.extend({
  items: z.array(referenceOptionSchema.extend({ contact: z.string(), notes: z.string() })),
})

export const materialInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  categoryId: z.uuid(),
  unitId: z.uuid(),
  supplierId: z.uuid().nullable(),
  minimumQuantity: z.number().min(0).max(1_000_000_000),
  notes: z.string().trim().max(2_000),
})
export const materialSortSchema = z.enum(["name", "code", "category", "minimum"])
export const materialStatusSchema = z.enum(["active", "archived", "all"])
export const materialQuerySchema = listQuerySchema.extend({
  sort: materialSortSchema.optional(),
  direction: z.enum(["asc", "desc"]).optional(),
  status: materialStatusSchema.optional(),
  id: z.uuid().optional(),
})
export const materialViewSchema = materialInputSchema.extend({
  id: z.uuid(),
  code: z.string(),
  categoryName: z.string(),
  unitName: z.string(),
  supplierName: z.string().nullable(),
  archived: z.boolean(),
  mergedIntoId: z.uuid().nullable(),
})
export const materialListSchema = z.strictObject({
  items: z.array(materialViewSchema),
  total: z.number().int(),
  actions: z.strictObject({ create: z.boolean(), edit: z.boolean(), archive: z.boolean(), overrideSimilarity: z.boolean() }),
})

export const similarityReportSchema = z.strictObject({
  level: z.enum(["clear", "warning", "high", "exact"]),
  matches: z.array(z.strictObject({
    id: z.uuid(), name: z.string(), code: z.string(), archived: z.boolean(), score: z.number(),
  })),
})
export const similarityCheckSchema = z.strictObject({
  name: materialInputSchema.shape.name, unitId: z.uuid(), exclude: z.uuid().optional(),
})
export const materialWriteSchema = materialInputSchema.extend({ confirmSimilarity: z.boolean().optional() })
export const mergeMaterialSchema = z.strictObject({ targetId: z.uuid() })
export const csvHeaders = ["name", "category", "unit", "supplier", "minimumQuantity", "notes"] as const
export const csvLimit = 5 * 1024 * 1024
export const csvRowLimit = 5_000
export const importQuerySchema = z.strictObject({
  mode: z.enum(["preview", "save"]), confirmSimilarity: z.enum(["true", "false"]).optional(),
})
export const importReportSchema = z.strictObject({
  accepted: z.number(), skipped: z.number(),
  issues: z.array(z.strictObject({ row: z.number(), reason: z.string(), similarity: similarityReportSchema.optional() })),
})
export type SimilarityReport = z.infer<typeof similarityReportSchema>

export type LookupKind = z.infer<typeof lookupKindSchema>
export type MaterialInput = z.infer<typeof materialInputSchema>
export type MaterialView = z.infer<typeof materialViewSchema>
export const materialStockSchema = z.strictObject({
  items: z.array(z.strictObject({
    branchId: z.uuid(), branchName: z.string(), quantity: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  })),
  total: z.number().int(),
})
export type MaterialQuery = z.infer<typeof materialQuerySchema>
export type ReferenceOption = z.infer<typeof referenceOptionSchema>
export type SupplierInput = z.infer<typeof supplierInputSchema>
