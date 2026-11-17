import { createSnapshot, restoreSnapshot } from "../db/backup.js"

const [command, ...extra] = process.argv.slice(2)
const databasePath = process.env.DATABASE_PATH || "./data/rawmat.sqlite"

try {
  process.umask(0o077)
  if (extra.length === 0 && command === "create") {
    console.log(await createSnapshot(databasePath))
  } else if (extra.length === 0 && command === "restore" && !process.stdin.isTTY) {
    await restoreSnapshot(databasePath, process.stdin)
    console.log("Database restored. Existing sessions were cleared.")
  } else {
    console.error("Usage: database-backup create | database-backup restore < snapshot.sqlite")
    process.exitCode = 1
  }
} catch {
  console.error(command === "create"
    ? "Backup failed. Check database access, integrity and free space."
    : "Restore failed. Use a validated snapshot and a fresh data volume with the app stopped.")
  process.exitCode = 1
}
