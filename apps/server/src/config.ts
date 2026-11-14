import { z } from "zod"

const appUrlSchema = z.url().transform((value) => new URL(value)).refine((url) => {
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
  const validProtocol = url.protocol === "https:" || (url.protocol === "http:" && loopback)
  return validProtocol && url.href === `${url.origin}/`
})

export const port = 8080
export const healthHost = `127.0.0.1:${port}`

export function readAppUrl(value: string | undefined): URL {
  const result = appUrlSchema.safeParse(value)
  if (!result.success) {
    throw new Error("APP_URL must be an HTTPS origin or an HTTP loopback origin")
  }
  return result.data
}
