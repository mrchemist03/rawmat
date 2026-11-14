import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

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
}, (table) => [
  index("audit_log_action").on(table.action),
])
