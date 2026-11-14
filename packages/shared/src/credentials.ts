import { z } from "zod"

export const loginNameSchema = z.string().trim().min(3).max(64)
  .regex(/^[\p{L}\p{N}_.-]+$/u)
  .transform((name) => name.toLowerCase())

export const newPasswordSchema = z.string().max(128)
  .refine((password) => [...password].length >= 12)
