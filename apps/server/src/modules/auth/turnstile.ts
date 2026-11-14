import { z } from "zod"

export const challengeOrigin = "https://challenges.cloudflare.com"
const responseLimit = 16 * 1024
const verification = z.object({
  success: z.boolean(),
  hostname: z.string().optional(),
  action: z.string().optional(),
  "error-codes": z.array(z.string()).optional(),
})

export async function verifyTurnstile(token: string, secret: string, hostname: string, request = fetch) {
  try {
    const response = await request(`${challengeOrigin}/turnstile/v0/siteverify`, {
      method: "POST",
      body: new URLSearchParams({ secret, response: token }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      return "unavailable"
    }

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > responseLimit) {
        await reader.cancel()
        return "unavailable"
      }
      chunks.push(value)
    }

    const result = verification.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")))
    if (!result.success || result.data["error-codes"]?.some((code) =>
      ["internal-error", "missing-input-secret", "invalid-input-secret"].includes(code))) {
      return "unavailable"
    }
    return result.data.success && result.data.hostname === hostname && result.data.action === "login"
      ? "verified"
      : "rejected"
  } catch {
    return "unavailable"
  }
}
