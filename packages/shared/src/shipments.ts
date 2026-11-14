import { z } from "zod"
import { listQuerySchema } from "./management.js"

export const shipmentStatus = z.enum(["registered", "picked_up", "in_transit", "out_for_delivery", "delivered", "exception", "returned"])
export const trackingNumberSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{5,32}$/)
const quantity = z.number().positive().max(1_000_000_000)
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const item = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("material"), materialId: z.uuid(), quantity }),
  z.strictObject({ kind: z.literal("description"), description: z.string().trim().min(1).max(250), quantity }),
])

export const shipmentInputSchema = z.strictObject({
  trackingNumber: trackingNumberSchema, sourceId: z.uuid(), destinationId: z.uuid(), dispatchedOn: z.iso.date(),
  items: z.array(item).min(1).max(100).refine((items) => {
    const ids = items.flatMap((row) => row.kind === "material" ? [row.materialId] : [])
    return new Set(ids).size === ids.length
  }),
}).refine((row) => row.sourceId !== row.destinationId)

export const shipmentUpdateSchema = z.strictObject({
  revision, status: shipmentStatus.exclude(["registered"]), location: z.string().trim().max(120),
  description: z.string().trim().min(1).max(500),
})
const receiptQuantity = z.string().max(338).regex(/^\d{1,10}(?:\.\d{1,325})?$/)
export const shipmentReceiptSchema = z.strictObject({
  revision, items: z.array(z.strictObject({ itemId: z.uuid(), quantity: receiptQuantity }))
    .min(1).max(100).refine((items) => new Set(items.map(({ itemId }) => itemId)).size === items.length),
})

export const shipmentQuerySchema = listQuerySchema.extend({
  status: shipmentStatus.optional(), sort: z.enum(["newest", "dispatch"]).optional(),
})
const eventSchema = z.strictObject({
  id: z.uuid(), status: shipmentStatus, location: z.string(), description: z.string(), occurredAt: z.number().int(),
})
const summary = z.strictObject({
  id: z.uuid(), trackingNumber: trackingNumberSchema, sourceName: z.string(), destinationName: z.string(),
  dispatchedOn: z.iso.date(), status: shipmentStatus, lastEvent: eventSchema, receivedAt: z.number().int().nullable(),
})
export const shipmentListSchema = z.strictObject({ items: z.array(summary), total: z.number().int() })
export const shipmentDetailSchema = summary.extend({
  revision, events: z.array(eventSchema),
  actions: z.strictObject({ update: z.boolean(), receive: z.boolean() }),
  items: z.array(z.strictObject({
    id: z.uuid(), name: z.string(), unitName: z.string().nullable(), quantity: receiptQuantity,
    receivedQuantity: receiptQuantity.nullable(),
  })),
})
export const shipmentIdSchema = z.strictObject({ id: z.uuid() })

export type ShipmentInput = z.infer<typeof shipmentInputSchema>
export type ShipmentQuery = z.infer<typeof shipmentQuerySchema>
export type ShipmentUpdate = z.infer<typeof shipmentUpdateSchema>
export type ShipmentReceipt = z.infer<typeof shipmentReceiptSchema>
export type ShipmentStatus = z.infer<typeof shipmentStatus>
export type ShipmentDetail = z.infer<typeof shipmentDetailSchema>
