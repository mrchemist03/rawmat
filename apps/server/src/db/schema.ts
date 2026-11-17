import { sql } from "drizzle-orm"
import { check, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core"
import { uniqueIndex } from "drizzle-orm/sqlite-core"
import type { NotificationEvent, NotificationType, PurchaseStatus, ShipmentStatus } from "@rawmat/shared"

export const branches = sqliteTable("branches", {
  id: text().primaryKey(),
  name: text().notNull().unique(),
  city: text().notNull(),
  active: integer({ mode: "boolean" }).notNull().default(true),
})

export const users = sqliteTable("users", {
  id: text().primaryKey(),
  name: text().notNull(),
  loginName: text("login_name").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text({ enum: ["user", "admin", "superuser"] }).notNull(),
  branchId: text("branch_id").references(() => branches.id),
  active: integer({ mode: "boolean" }).notNull().default(true),
  mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(true),
}, (table) => [
  check("users_role_valid", sql`${table.role} in ('user', 'admin', 'superuser')`),
])

export const sessions = sqliteTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  lastActiveAt: integer("last_active_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [
  index("sessions_user").on(table.userId),
  index("sessions_expiry").on(table.expiresAt),
])

export const loginAttempts = sqliteTable("login_attempts", {
  id: integer().primaryKey(),
  accountKey: text("account_key").notNull(),
  addressKey: text("address_key").notNull(),
  attemptedAt: integer("attempted_at").notNull(),
}, (table) => [
  index("login_attempts_account_window").on(table.accountKey, table.attemptedAt),
  index("login_attempts_address_window").on(table.addressKey, table.attemptedAt),
  index("login_attempts_time").on(table.attemptedAt),
])

export const turnstileRedemptions = sqliteTable("turnstile_redemptions", {
  tokenHash: text("token_hash").primaryKey(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [
  index("turnstile_redemptions_expiry").on(table.expiresAt),
])

export const auditLog = sqliteTable("audit_log", {
  id: text().primaryKey(),
  actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
  action: text().notNull(),
  entity: text().notNull(),
  entityId: text("entity_id").notNull(),
  occurredAt: integer("occurred_at").notNull(),
  before: text({ mode: "json" }).$type<Record<string, string | boolean | number | null>>(),
  after: text({ mode: "json" }).$type<Record<string, string | boolean | number | null>>(),
}, (table) => [
  index("audit_log_action").on(table.action),
])

export const categories = sqliteTable("categories", {
  id: text().primaryKey().notNull(),
  name: text().notNull().unique(),
})

export const units = sqliteTable("units", {
  id: text().primaryKey().notNull(),
  name: text().notNull().unique(),
})

export const suppliers = sqliteTable("suppliers", {
  id: text().primaryKey().notNull(),
  name: text().notNull().unique(),
  contact: text().notNull().default(""),
  notes: text().notNull().default(""),
})

export const materials = sqliteTable("materials", {
  id: text().primaryKey().notNull(),
  code: text().notNull().unique(),
  name: text().notNull(),
  nameNormalized: text("name_normalized").notNull().default(""),
  legacyDuplicate: integer("legacy_duplicate", { mode: "boolean" }).notNull().default(false),
  categoryId: text("category_id").notNull().references(() => categories.id),
  unitId: text("unit_id").notNull().references(() => units.id),
  supplierId: text("supplier_id").references(() => suppliers.id),
  minimumQuantity: real("minimum_quantity").notNull(),
  notes: text().notNull().default(""),
  archived: integer({ mode: "boolean" }).notNull().default(false),
  mergedIntoId: text("merged_into_id").references((): AnySQLiteColumn => materials.id),
}, (table) => [
  check("material_minimum_valid", sql`${table.minimumQuantity} between 0 and 1000000000`),
  index("materials_status_name").on(table.archived, table.name, table.id),
  index("materials_category").on(table.categoryId),
  index("materials_unit").on(table.unitId),
  index("materials_supplier").on(table.supplierId),
  uniqueIndex("materials_normalized_unit_unique").on(table.nameNormalized, table.unitId)
    .where(sql`${table.mergedIntoId} is null and ${table.legacyDuplicate} = 0 and ${table.nameNormalized} <> ''`),
  index("materials_merge_target").on(table.mergedIntoId),
])

export const purchaseRequests = sqliteTable("purchase_requests", {
  id: text().primaryKey().notNull(),
  number: text().notNull().unique(),
  branchId: text("branch_id").notNull().references(() => branches.id),
  requestedBy: text("requested_by").notNull().references(() => users.id),
  supplierId: text("supplier_id").references(() => suppliers.id),
  neededOn: text("needed_on").notNull(),
  notes: text().notNull().default(""),
  status: text().$type<PurchaseStatus>().notNull().default("draft"),
  revision: integer().notNull().default(1),
  createdAt: integer("created_at").notNull(),
  submittedAt: integer("submitted_at"),
  decisionReason: text("decision_reason"),
  orderedAt: integer("ordered_at"),
}, (table) => [
  check("purchase_requests_status_valid", sql`${table.status} in ('draft','submitted','approved','rejected','ordered','partially_received','received','cancelled')`),
  check("purchase_requests_revision_valid", sql`${table.revision} >= 1`),
  index("purchase_requests_status_created").on(table.status, table.createdAt),
  index("purchase_requests_needed").on(table.neededOn),
  index("purchase_requests_branch").on(table.branchId),
  index("purchase_requests_requester").on(table.requestedBy),
  index("purchase_requests_supplier").on(table.supplierId),
])

export const purchaseRequestItems = sqliteTable("purchase_request_items", {
  id: text().primaryKey().notNull(),
  requestId: text("request_id").notNull().references(() => purchaseRequests.id, { onDelete: "cascade" }),
  position: integer().notNull(),
  materialId: text("material_id").notNull().references(() => materials.id),
  quantity: real().notNull(),
  receivedQuantity: real("received_quantity").notNull().default(0),
  receivedExact: text("received_exact").notNull().default("0"),
}, (table) => [
  uniqueIndex("purchase_items_request_material").on(table.requestId, table.materialId),
  uniqueIndex("purchase_items_request_position").on(table.requestId, table.position),
  index("purchase_items_material").on(table.materialId),
  check("purchase_items_quantity_valid", sql`${table.quantity} > 0 and ${table.quantity} <= 1000000000`),
  check("purchase_items_received_valid", sql`${table.receivedQuantity} between 0 and ${table.quantity}`),
])

export const purchaseItemCosts = sqliteTable("purchase_item_costs", {
  itemId: text("item_id").primaryKey().notNull().references(() => purchaseRequestItems.id, { onDelete: "cascade" }),
  unitPriceMinor: integer("unit_price_minor").notNull(),
  currency: text().notNull(),
}, (table) => [
  check("purchase_item_price_valid", sql`${table.unitPriceMinor} between 0 and 1000000000000`),
  check("purchase_item_currency_valid", sql`${table.currency} glob '[A-Z][A-Z][A-Z]'`),
])

export const materialCosts = sqliteTable("material_costs", {
  materialId: text("material_id").notNull().references(() => materials.id),
  currency: text().notNull(),
  lastUnitPriceMinor: integer("last_unit_price_minor").notNull(),
  averageUnitPriceMinor: integer("average_unit_price_minor").notNull(),
}, (table) => [
  uniqueIndex("material_costs_material_currency").on(table.materialId, table.currency),
])

export const stockMovements = sqliteTable("stock_movements", {
  id: text().primaryKey().notNull(),
  branchId: text("branch_id").notNull().references(() => branches.id),
  materialId: text("material_id").notNull().references(() => materials.id),
  quantity: text().notNull(),
  kind: text().notNull(),
  referenceId: text("reference_id").notNull(),
  referenceItemId: text("reference_item_id").notNull(),
  referenceRevision: integer("reference_revision").notNull(),
  occurredAt: integer("occurred_at").notNull(),
}, (table) => [
  uniqueIndex("stock_movements_reference").on(table.kind, table.referenceId, table.referenceItemId, table.referenceRevision),
  index("stock_movements_material_branch").on(table.materialId, table.branchId),
])

export const shipments = sqliteTable("shipments", {
  id: text().primaryKey().notNull(),
  trackingNumber: text("tracking_number").notNull().unique(),
  sourceId: text("source_id").notNull().references(() => branches.id),
  destinationId: text("destination_id").notNull().references(() => branches.id),
  dispatchedOn: text("dispatched_on").notNull(),
  createdBy: text("created_by").notNull().references(() => users.id),
  status: text().$type<ShipmentStatus>().notNull().default("registered"),
  revision: integer().notNull().default(1),
  receivedAt: integer("received_at"),
  createdAt: integer("created_at").notNull(),
  nextPollAt: integer("next_poll_at").notNull().default(0),
  pollLeaseUntil: integer("poll_lease_until"),
  pollFailures: integer("poll_failures").notNull().default(0),
  lastPolledAt: integer("last_polled_at"),
  trackingChangedAt: integer("tracking_changed_at"),
  lastRefreshAt: integer("last_refresh_at"),
}, (table) => [
  check("shipment_branches_distinct", sql`${table.sourceId} <> ${table.destinationId}`),
  check("shipment_status_valid", sql`${table.status} in ('registered','picked_up','in_transit','out_for_delivery','delivered','exception','returned')`),
  index("shipments_status_date").on(table.status, table.dispatchedOn),
  index("shipments_next_poll").on(table.nextPollAt).where(sql`${table.receivedAt} is null and ${table.status} not in ('delivered', 'returned')`),
])

export const shipmentItems = sqliteTable("shipment_items", {
  id: text().primaryKey().notNull(),
  shipmentId: text("shipment_id").notNull().references(() => shipments.id),
  position: integer().notNull(),
  materialId: text("material_id").references(() => materials.id),
  description: text(),
  quantity: text().notNull(),
  receivedQuantity: text("received_quantity"),
}, (table) => [
  check("shipment_item_variant", sql`(${table.materialId} is null) <> (${table.description} is null)`),
  uniqueIndex("shipment_items_position").on(table.shipmentId, table.position),
  uniqueIndex("shipment_items_material_unique").on(table.shipmentId, table.materialId),
  index("shipment_items_material").on(table.materialId),
])

export const trackingEvents = sqliteTable("tracking_events", {
  id: text().primaryKey().notNull(),
  shipmentId: text("shipment_id").notNull().references(() => shipments.id),
  status: text().$type<ShipmentStatus>().notNull(),
  code: text().notNull(),
  description: text().notNull(),
  location: text().notNull().default(""),
  occurredAt: integer("occurred_at").notNull(),
  revision: integer().notNull(),
  source: text().notNull(),
  raw: text(),
}, (table) => [
  uniqueIndex("tracking_events_revision").on(table.shipmentId, table.revision),
  uniqueIndex("tracking_events_event").on(table.shipmentId, table.code, table.occurredAt),
  index("tracking_events_timeline").on(table.shipmentId, table.occurredAt, table.revision),
])

export const notificationRecipients = sqliteTable("notification_recipients", {
  id: text().primaryKey().notNull(),
  name: text().notNull(),
  phone: text().notNull().unique(),
  active: integer({ mode: "boolean" }).notNull(),
  revision: integer().notNull().default(1),
})

export const notificationRules = sqliteTable("notification_rules", {
  event: text().$type<NotificationType>().primaryKey().notNull(),
  enabled: integer({ mode: "boolean" }).notNull(),
  recipientIds: text("recipient_ids", { mode: "json" }).$type<string[]>().notNull(),
})

export const notificationOutbox = sqliteTable("notification_outbox", {
  id: text().primaryKey().notNull(),
  event: text().$type<NotificationEvent>().notNull(),
  dedupeKey: text("dedupe_key").notNull().unique(),
  occurredAt: integer("occurred_at").notNull(),
  message: text().notNull(),
  data: text({ mode: "json" }).$type<Record<string, string>>().notNull(),
  recipients: text({ mode: "json" }).$type<{ id: string; revision: number }[]>().notNull(),
  state: text().$type<"pending" | "sent" | "failed">().notNull().default("pending"),
  attempts: integer().notNull().default(0),
  nextAttemptAt: integer("next_attempt_at").notNull(),
  leaseUntil: integer("lease_until"),
  sentAt: integer("sent_at"),
  lastError: text("last_error").$type<"connection" | "response" | "http" | "recipients">(),
}, (table) => [
  index("notification_pending").on(table.nextAttemptAt).where(sql`${table.state} = 'pending'`),
  index("notification_history").on(table.occurredAt, table.id),
])
