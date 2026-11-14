import { fileURLToPath } from "node:url"
import { buildApp } from "./app.js"
import { port, readAppUrl } from "./config.js"

try {
  const appUrl = readAppUrl(process.env.APP_URL)
  const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url))
  const app = buildApp(appUrl, webRoot)
  const shutdown = () => {
    app.close().catch(() => {
      app.log.error("server shutdown failed")
      process.exitCode = 1
    })
  }

  process.once("SIGTERM", shutdown)
  process.once("SIGINT", shutdown)
  await app.listen({ host: "0.0.0.0", port })
} catch {
  console.error(JSON.stringify({
    level: "error",
    message: "Server startup failed. Verify APP_URL and port 8080.",
  }))
  process.exitCode = 1
}
