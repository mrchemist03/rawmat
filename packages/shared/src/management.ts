import { z } from "zod"
import { loginNameSchema, newPasswordSchema } from "./credentials.js"

export const navigationItemSchema = z.enum(["account", "materials", "purchases", "shipments", "notifications", "accounts", "branches", "references", "audit"])
export const meSchema = z.strictObject({
  name: z.string(),
  navigation: z.array(navigationItemSchema),
})

export const accountTypeSchema = z.enum(["user", "admin", "superuser"])
const nameSchema = z.string().trim().min(1).max(120)
const accountFields = {
  name: nameSchema,
  loginName: loginNameSchema,
  branchId: z.uuid().nullable(),
}

export const createAccountSchema = z.strictObject({
  ...accountFields,
  accountType: accountTypeSchema,
  temporaryPassword: newPasswordSchema,
})

export const updateAccountSchema = z.strictObject({
  ...accountFields,
  active: z.boolean(),
  accountType: accountTypeSchema.optional(),
  temporaryPassword: newPasswordSchema.optional(),
})

export const accountViewSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  loginName: z.string(),
  active: z.boolean(),
  branchId: z.uuid().nullable(),
  branchName: z.string().nullable(),
  isCurrentAccount: z.boolean(),
})

export const createBranchSchema = z.strictObject({ name: nameSchema, city: nameSchema })
export const updateBranchSchema = createBranchSchema.extend({ active: z.boolean() })
export const branchViewSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  city: z.string(),
  active: z.boolean(),
})

export const listQuerySchema = z.strictObject({
  page: z.string().regex(/^[1-9]\d{0,5}$/).transform(Number).optional(),
  search: z.string().trim().max(120).optional(),
})

export const pageSize = 25
export const accountListSchema = z.strictObject({ items: z.array(accountViewSchema), total: z.number().int() })
export const branchListSchema = z.strictObject({ items: z.array(branchViewSchema), total: z.number().int() })

export type NavigationItem = z.infer<typeof navigationItemSchema>
export type AccountType = z.infer<typeof accountTypeSchema>
export type AccountView = z.infer<typeof accountViewSchema>
export type BranchView = z.infer<typeof branchViewSchema>
