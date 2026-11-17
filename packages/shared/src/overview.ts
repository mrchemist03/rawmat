import { z } from "zod"
import { purchaseCurrencySchema, purchaseStatus } from "./purchases.js"

const count = z.number().int().nonnegative()
const minor = z.string().regex(/^\d+$/)
export const overviewSchema = z.strictObject({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  purchases: z.strictObject({
    statuses: z.record(purchaseStatus, count),
    overdue: count,
  }),
  lowStock: count,
  shipments: z.strictObject({
    inTransit: count, overdue: count, deliveredThisMonth: count,
    routes: z.array(z.strictObject({
      sourceId: z.uuid(), sourceName: z.string(), destinationId: z.uuid(), destinationName: z.string(),
      count, averageDays: z.number().nonnegative(),
    })),
  }),
  activity: z.array(z.strictObject({ id: z.uuid(), action: z.string(), occurredAt: z.number().int() })).max(10),
  spending: z.array(z.strictObject({
    currency: purchaseCurrencySchema, totalMinor: minor,
    materials: z.array(z.strictObject({ id: z.uuid(), name: z.string(), amountMinor: minor })).max(5),
  })).optional(),
})

export type Overview = z.infer<typeof overviewSchema>
