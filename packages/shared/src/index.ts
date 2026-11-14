import { z } from "zod"

export const healthResponseSchema = z.strictObject({
  status: z.literal("ok"),
})

export const loginNameSchema = z.string().trim().min(3).max(64)
  .regex(/^[\p{L}\p{N}_.-]+$/u)
  .transform((name) => name.toLowerCase())

export const newPasswordSchema = z.string().max(128)
  .refine((password) => [...password].length >= 12)

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
