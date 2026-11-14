import { sql } from "drizzle-orm"
import { check, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core"
import { uniqueIndex } from "drizzle-orm/sqlite-core"
import type { PurchaseStatus } from "@rawmat/shared"

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
}, (table) => [
  uniqueIndex("purchase_items_request_material").on(table.requestId, table.materialId),
  uniqueIndex("purchase_items_request_position").on(table.requestId, table.position),
  index("purchase_items_material").on(table.materialId),
  check("purchase_items_quantity_valid", sql`${table.quantity} > 0 and ${table.quantity} <= 1000000000`),
  check("purchase_items_received_valid", sql`${table.receivedQuantity} between 0 and ${table.quantity}`),
])
