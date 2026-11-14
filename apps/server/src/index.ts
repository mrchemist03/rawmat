import { fileURLToPath } from "node:url"
import { buildApp } from "./app.js"
import { port, readServerConfig } from "./config.js"
import { openDatabase } from "./db/database.js"

try {
  process.umask(0o077)
  const config = readServerConfig(process.env)
  const database = openDatabase(config.databasePath)
  const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url))
  const app = buildApp(config.appUrl, webRoot, true, {
    config, db: database.db, trustProxy: config.trustProxy,
    similarityThresholds: config.similarityThresholds,
    baseCurrency: config.baseCurrency,
    brandingRoot: process.env.BRANDING_PATH || "./deploy/branding",
  })
  app.addHook("onClose", async () => database.close())
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
    message: "Server startup failed. Verify runtime settings, database access and port 8080.",
  }))
  process.exitCode = 1
}
