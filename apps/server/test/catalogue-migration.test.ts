import { randomUUID } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { drizzle } from "drizzle-orm/node-sqlite"
import { migrate } from "drizzle-orm/node-sqlite/migrator"
import { expect, test } from "vitest"
import { openDatabase } from "../src/db/database.js"
import { materials } from "../src/db/schema.js"

test("upgrades a catalogue containing legacy duplicates without deleting or hiding rows", () => {
  const directory = mkdtempSync(join(tmpdir(), "rawmat-migration-"))
  const path = join(directory, "local.sqlite")
  const prior = join(directory, "prior")
  try {
    const earlierMigrations = readdirSync(new URL("../migrations/", import.meta.url))
      .filter((folder) => folder.endsWith("_auth") || folder.endsWith("_catalogue"))
    expect(earlierMigrations).toHaveLength(2)
    for (const folder of earlierMigrations) {
      mkdirSync(join(prior, folder), { recursive: true })
      copyFileSync(new URL(`../migrations/${folder}/migration.sql`, import.meta.url), join(prior, folder, "migration.sql"))
    }
    const raw = new DatabaseSync(path)
    try {
      migrate(drizzle({ client: raw }), { migrationsFolder: prior })
      const category = randomUUID()
      const unit = randomUUID()
      raw.prepare("insert into categories values (?, ?)").run(category, "فئة")
      raw.prepare("insert into units values (?, ?)").run(unit, "كغ")
      const insert = raw.prepare("insert into materials(id, code, name, category_id, unit_id, minimum_quantity) values (?, ?, ?, ?, ?, 0)")
      insert.run(randomUUID(), "OLD-1", "بُودرةُ الحليب", category, unit)
      insert.run(randomUUID(), "OLD-2", "بودره الحليب", category, unit)
    } finally {
      raw.close()
    }
    for (let pass = 0; pass < 2; pass++) {
      const db = openDatabase(path)
      try {
        const rows = db.db.select().from(materials).all()
        expect(rows.map((row) => row.code).sort()).toEqual(["OLD-1", "OLD-2"])
        expect(rows.every((row) => row.nameNormalized === "بودره الحليب" && !row.archived)).toBe(true)
        expect(rows.filter((row) => row.legacyDuplicate)).toHaveLength(1)
      } finally {
        db.close()
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
