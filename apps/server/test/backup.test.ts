import { createReadStream } from "node:fs"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Readable } from "node:stream"
import { sql } from "drizzle-orm"
import { afterEach, beforeEach, expect, test } from "vitest"
import { createSnapshot, restoreSnapshot } from "../src/db/backup.js"
import { openDatabase } from "../src/db/database.js"

let root: string
let source: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rawmat-backup-"))
  source = join(root, "source.sqlite")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test("copies committed WAL data, restores into an empty volume, and invalidates snapshot sessions", async () => {
  const original = openDatabase(source)
  const destination = join(root, "recovery", "rawmat.sqlite")
  try {
    original.db.run(sql`INSERT INTO users (id, login_name, name, password_hash, role)
      VALUES ('fixture', 'fixture', 'Fixture', 'fixture-hash', 'superuser')`)
    original.db.run(sql`INSERT INTO sessions (token_hash, user_id, last_active_at, expires_at)
      VALUES ('fixture-session', 'fixture', 1, 10)`)
    const snapshot = await createSnapshot(source)
    await restoreSnapshot(destination, createReadStream(snapshot))

    const recovered = openDatabase(destination)
    try {
      expect(recovered.db.get(sql`SELECT name FROM users`)).toEqual({ name: "Fixture" })
      expect(recovered.db.get(sql`SELECT count(*) AS count FROM sessions`)).toEqual({ count: 0 })
      expect(original.db.get(sql`SELECT count(*) AS count FROM sessions`)).toEqual({ count: 1 })
    } finally {
      recovered.close()
    }
    await expect(restoreSnapshot(destination, Readable.from([]))).rejects.toThrow("new data volume")
  } finally {
    original.close()
  }
})

test("rejects a corrupt snapshot and volumes with stale sidecars", async () => {
  const destination = join(root, "rawmat.sqlite")
  await expect(restoreSnapshot(destination, Readable.from([Buffer.from("invalid fixture")]))).rejects.toThrow()
  expect(await readdir(root)).toEqual([])
  await writeFile(destination + "-wal", "")
  await expect(restoreSnapshot(destination, Readable.from([]))).rejects.toThrow("new data volume")
  expect(await readdir(root)).toEqual(["rawmat.sqlite-wal"])
})

test("retains fourteen snapshots without deleting unrelated files", async () => {
  const original = openDatabase(source)
  original.close()
  const folder = dirname(await createSnapshot(source))
  await writeFile(join(folder, "operator.sqlite"), "")
  for (let count = 0; count < 14; count++) await createSnapshot(source)
  expect(await readdir(folder)).toHaveLength(15)
  expect((await readdir(folder)).includes("operator.sqlite")).toBe(true)
  const restored = new DatabaseSync(source, { readOnly: true })
  try {
    expect(restored.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
  } finally {
    restored.close()
  }
})
