import { randomUUID } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { drizzle } from "drizzle-orm/node-sqlite"
import { migrate } from "drizzle-orm/node-sqlite/migrator"
import { expect, test } from "vitest"
import { openDatabase } from "../src/db/database.js"
import { shipments, trackingEvents } from "../src/db/schema.js"
import { createTrackingPoller } from "../src/modules/shipments/polling.js"

test("upgrades existing tracking history and reinterprets its next carrier response without duplicating events", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rawmat-tracking-migration-"))
  const path = join(directory, "fixture.sqlite")
  const prior = join(directory, "prior")
  const id = randomUUID()
  const actor = randomUUID()
  const source = randomUUID()
  const destination = randomUUID()
  const time = 1_800_000_000_000
  try {
    for (const folder of readdirSync(new URL("../migrations/", import.meta.url)).filter((name) => !name.endsWith("_carrier_event_status"))) {
      mkdirSync(join(prior, folder), { recursive: true })
      copyFileSync(new URL(`../migrations/${folder}/migration.sql`, import.meta.url), join(prior, folder, "migration.sql"))
    }
    const legacy = openDatabase(path, false)
    try {
      migrate(drizzle({ client: legacy.db.$client }), { migrationsFolder: prior })
      legacy.db.$client.prepare("insert into branches(id, name, city) values (?, 'Source', 'City'), (?, 'Destination', 'City')")
        .run(source, destination)
      legacy.db.$client.prepare("insert into users(id, name, login_name, password_hash, role) values (?, 'Fixture', 'fixture', 'fixture', 'user')").run(actor)
      legacy.db.$client.prepare("insert into shipments(id, tracking_number, source_id, destination_id, dispatched_on, created_by, created_at, revision) values (?, 'UPGRADE001', ?, ?, '2026-11-10', ?, ?, 2)")
        .run(id, source, destination, actor, time)
      legacy.db.$client.prepare("insert into tracking_events(id, shipment_id, status, code, description, location, occurred_at, revision, source) values (?, ?, 'registered', 'carrier:ORIGIN', 'Received at Origin Facility', 'Old location', ?, 2, 'carrier')")
        .run(randomUUID(), id, time - 10)
    } finally { legacy.close() }
    const upgraded = openDatabase(path)
    try {
      expect(upgraded.db.select().from(trackingEvents).get()).toMatchObject({ carrierStatus: null, location: "Old location" })
      const worker = createTrackingPoller(upgraded.db, { track: async () => [{ awb: "UPGRADE001", events: [{
        code: "ORIGIN", status: "in_transit", description: "Received at Origin Facility", location: "Corrected location", occurredAt: time - 10,
      }] }] }, () => time)
      await worker.run()
      expect(upgraded.db.select().from(shipments).get()?.status).toBe("in_transit")
      const events = upgraded.db.select().from(trackingEvents).all()
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ carrierStatus: "in_transit", status: "in_transit", location: "Corrected location" })
    } finally { upgraded.close() }
    openDatabase(path).close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
