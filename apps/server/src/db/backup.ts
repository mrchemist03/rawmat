import { randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { link, lstat, mkdir, mkdtemp, readdir, rm, unlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { backup, DatabaseSync } from "node:sqlite"

const retention = 14
const snapshotName = /^rawmat-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f-]{36}\.sqlite$/

function verifySnapshot(path: string, restoring: boolean) {
  const database = new DatabaseSync(path, { timeout: 5_000 })
  try {
    database.exec("PRAGMA journal_mode = DELETE")
    const checks = database.prepare("PRAGMA integrity_check(1)").all()
    const rawmatTables = database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('users', 'sessions', 'materials')",
    ).all()
    if (checks.length !== 1 || checks[0]?.integrity_check !== "ok" ||
        rawmatTables.length !== 3 || database.prepare("PRAGMA foreign_key_check").get()) {
      throw new Error("Invalid Rawmat snapshot")
    }
    if (restoring) database.exec("DELETE FROM sessions")
  } finally {
    database.close()
  }
}

export async function createSnapshot(databasePath: string) {
  const folder = join(dirname(resolve(databasePath)), "backups")
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const scratch = await mkdtemp(join(folder, ".snapshot-"))
  const staged = join(scratch, "snapshot.sqlite")
  const date = new Date().toISOString().replaceAll(":", "-")
  const name = `rawmat-${date}-${randomUUID()}.sqlite`
  const destination = join(folder, name)
  try {
    const source = new DatabaseSync(databasePath, { readOnly: true, timeout: 5_000 })
    try {
      await backup(source, staged)
    } finally {
      source.close()
    }
    verifySnapshot(staged, false)
    await link(staged, destination)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  const snapshots = (await readdir(folder, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && snapshotName.test(entry.name))
    .map((entry) => entry.name).sort().reverse()
  for (const expired of snapshots.slice(retention)) {
    await unlink(join(folder, expired)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }
  return destination
}

export async function restoreSnapshot(databasePath: string, input: Readable) {
  const destination = resolve(databasePath)
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      await lstat(destination + suffix)
      throw new Error("Restore requires a new data volume")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  const folder = dirname(destination)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const scratch = await mkdtemp(join(folder, ".restore-"))
  const staged = join(scratch, "snapshot.sqlite")
  try {
    await pipeline(input, createWriteStream(staged, { flags: "wx", mode: 0o600, flush: true }))
    verifySnapshot(staged, true)
    await link(staged, destination)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
