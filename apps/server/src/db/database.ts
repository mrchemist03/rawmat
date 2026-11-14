import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { drizzle } from "drizzle-orm/node-sqlite"
import { migrate } from "drizzle-orm/node-sqlite/migrator"

const migrationsFolder = fileURLToPath(new URL("../../migrations/", import.meta.url))

export function openDatabase(path: string, applyMigrations = true) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const client = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5_000 })
  try {
    client.exec("PRAGMA journal_mode = WAL")
    const db = drizzle({ client })
    if (applyMigrations) migrate(db, { migrationsFolder })
    return { db, close: () => client.close() }
  } catch (error) {
    client.close()
    throw error
  }
}

export type AppDatabase = ReturnType<typeof openDatabase>["db"]
