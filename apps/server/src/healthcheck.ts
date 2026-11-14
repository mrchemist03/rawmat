import { healthHost } from "./config.js"

try {
  const response = await fetch(`http://${healthHost}/healthz`, {
    redirect: "error",
    signal: AbortSignal.timeout(2_000),
  })
  await response.body?.cancel()
  process.exitCode = response.status === 200 ? 0 : 1
} catch {
  process.exitCode = 1
}
