import { z } from "zod"

export const notificationType = z.enum([
  "purchase.submitted", "purchase.decided", "purchase.received", "purchase.overdue",
  "shipment.updated", "shipment.delivered", "shipment.attention", "inventory.low",
])
export const notificationEvent = z.enum([...notificationType.options, "notification.test"])
export const notificationState = z.enum(["pending", "sent", "failed"])
export const notificationPhone = z.string().trim().regex(/^\+[1-9][0-9]{6,14}$/)
export const recipientLimit = 40

export const notificationRecipientInput = z.strictObject({
  name: z.string().trim().min(1).max(120), phone: notificationPhone, active: z.boolean(),
})
const recipientIds = z.array(z.uuid()).max(recipientLimit).refine((ids) => new Set(ids).size === ids.length)
export const notificationRuleInput = z.strictObject({ enabled: z.boolean(), recipientIds })
export const notificationsSettingsSchema = z.strictObject({
  configured: z.boolean(),
  recipients: z.array(notificationRecipientInput.extend({ id: z.uuid() })).max(recipientLimit),
  rules: z.array(notificationRuleInput.extend({ event: notificationType })),
})
export const notificationHistorySchema = z.strictObject({
  items: z.array(z.strictObject({
    id: z.uuid(), event: notificationEvent, state: notificationState, attempts: z.number().int(),
    occurredAt: z.number().int(), nextAttemptAt: z.number().int(), sentAt: z.number().int().nullable(),
    lastError: z.enum(["connection", "response", "http", "recipients", "expired"]).nullable(),
  })), total: z.number().int(),
})

export type NotificationType = z.infer<typeof notificationType>
export type NotificationEvent = z.infer<typeof notificationEvent>
export type NotificationRecipientInput = z.infer<typeof notificationRecipientInput>
export type NotificationRuleInput = z.infer<typeof notificationRuleInput>
