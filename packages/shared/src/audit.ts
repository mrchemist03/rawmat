import { z } from "zod"

const snapshot = z.record(z.string(), z.union([z.string(), z.boolean(), z.number(), z.null()])).nullable()

export const auditListSchema = z.strictObject({
  items: z.array(z.strictObject({
    id: z.uuid(), actorName: z.string().nullable(), action: z.string(), entity: z.string(),
    entityId: z.uuid(), occurredAt: z.number(), before: snapshot, after: snapshot,
  })),
  total: z.number().int(),
})
