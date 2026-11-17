import { z } from "zod"
import { loginNameSchema, newPasswordSchema } from "./credentials.js"

export * from "./credentials.js"
export * from "./management.js"
export * from "./catalogue.js"
export * from "./audit.js"
export * from "./purchases.js"
export * from "./shipments.js"
export * from "./notifications.js"

export const healthResponseSchema = z.strictObject({
  status: z.literal("ok"),
})

const submittedPasswordSchema = z.string().min(1).max(128)

export const loginSchema = z.strictObject({
  loginName: loginNameSchema,
  password: submittedPasswordSchema,
  turnstileToken: z.string().min(1).max(2048).optional(),
})

export const changePasswordSchema = z.strictObject({
  currentPassword: submittedPasswordSchema,
  newPassword: newPasswordSchema,
})

export const loginConfigSchema = z.strictObject({
  turnstileSiteKey: z.string().nullable(),
})

export const sessionViewSchema = z.strictObject({
  name: z.string(),
  mustChangePassword: z.boolean(),
})
