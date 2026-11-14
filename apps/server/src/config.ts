import { randomBytes } from "node:crypto"
import { purchaseCurrencySchema } from "@rawmat/shared"
import ipaddr from "ipaddr.js"
import { z } from "zod"
import { defaultThresholds } from "./modules/catalogue/similarity.js"

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

export function readServerConfig(env: NodeJS.ProcessEnv) {
  const appUrl = readAppUrl(env.APP_URL)
  const localDevelopment = env.RAWMAT_LOCAL_DEV === "1" && appUrl.protocol === "http:"
  const production = env.NODE_ENV === "production" && !localDevelopment
  if (production && appUrl.protocol !== "https:") throw new Error("Production requires HTTPS")

  const encodedSecret = env.SESSION_SECRET
  const sessionSecret = encodedSecret && /^[\da-fA-F]{64}$/.test(encodedSecret)
    ? Buffer.from(encodedSecret, "hex")
    : undefined
  if (!sessionSecret && (production || encodedSecret)) {
    throw new Error("SESSION_SECRET must contain 32 random bytes in hexadecimal")
  }

  const siteKey = env.TURNSTILE_SITE_KEY || undefined
  const secretKey = env.TURNSTILE_SECRET_KEY || undefined
  const keySchema = z.string().min(1).max(256).regex(/^[\w-]+$/)
  if ((siteKey || secretKey) && (!keySchema.safeParse(siteKey).success || !keySchema.safeParse(secretKey).success)) {
    throw new Error("Turnstile requires both keys")
  }

  const proxyRange = env.TRUSTED_PROXY_CIDR?.trim()
  if (proxyRange) ipaddr.parseCIDR(proxyRange)
  const warning = Number(env.MATERIAL_SIMILARITY_WARNING || defaultThresholds.warning)
  const high = Number(env.MATERIAL_SIMILARITY_HIGH || defaultThresholds.high)
  if (!(warning >= 0.5 && warning < high && high <= 1)) {
    throw new Error("Material similarity thresholds must satisfy 0.5 <= warning < high <= 1")
  }
  return {
    appUrl,
    sessionSecret: sessionSecret ?? randomBytes(32),
    trustProxy: proxyRange || (false as const),
    databasePath: env.DATABASE_PATH || "./data/rawmat.sqlite",
    turnstile: siteKey && secretKey ? { siteKey, secretKey } : undefined,
    similarityThresholds: { warning, high },
    baseCurrency: purchaseCurrencySchema.parse(env.BASE_CURRENCY || "TRY"),
  }
}
