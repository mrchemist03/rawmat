import { randomUUID } from "node:crypto"
import { and, count, eq, gt, lte } from "drizzle-orm"
import type { AppDatabase } from "../../db/database.js"
import { auditLog, loginAttempts, sessions, turnstileRedemptions, users } from "../../db/schema.js"

export const idleTimeout = 8 * 60 * 60 * 1000
const loginWindow = 15 * 60 * 1000
const loginLimit = 5
const turnstileLifetime = 5 * 60 * 1000

export function createAuthRepository(db: AppDatabase) {
  const sessionRecord = {
    id: users.id,
    name: users.name,
    role: users.role,
    branchId: users.branchId,
    mustChangePassword: users.mustChangePassword,
  }

  function findSession(tokenHash: string, now: number, connection: Pick<AppDatabase, "select"> = db) {
    return connection.select(sessionRecord)
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now), eq(users.active, true)))
      .get()
  }

  return {
    findSession,

    findUser(loginName: string) {
      return db.select({ ...sessionRecord, passwordHash: users.passwordHash })
        .from(users).where(and(eq(users.loginName, loginName), eq(users.active, true))).get()
    },

    reserveLoginAttempt(accountKey: string | null, addressKey: string | null, now: number,
      limit = loginLimit, window = loginWindow) {
      return db.transaction((tx) => {
        const cutoff = now - window
        tx.delete(loginAttempts).where(lte(loginAttempts.attemptedAt, now - loginWindow)).run()
        const account = accountKey === null ? undefined : tx.select({ count: count() }).from(loginAttempts)
          .where(and(eq(loginAttempts.accountKey, accountKey), gt(loginAttempts.attemptedAt, cutoff))).get()
        const address = addressKey === null ? undefined : tx.select({ count: count() }).from(loginAttempts)
          .where(and(eq(loginAttempts.addressKey, addressKey), gt(loginAttempts.attemptedAt, cutoff))).get()
        if ((account?.count ?? 0) >= limit || (address?.count ?? 0) >= limit) return false
        tx.insert(loginAttempts).values({
          accountKey: accountKey ?? "", addressKey: addressKey ?? "", attemptedAt: now,
        }).run()
        return true
      }, { behavior: "immediate" })
    },

    redeemTurnstile(tokenHash: string, now: number) {
      return db.transaction((tx) => {
        tx.delete(turnstileRedemptions).where(lte(turnstileRedemptions.expiresAt, now)).run()
        return tx.insert(turnstileRedemptions).values({ tokenHash, expiresAt: now + turnstileLifetime })
          .onConflictDoNothing().run().changes === 1
      }, { behavior: "immediate" })
    },

    replaceLoginSession(userId: string, passwordHash: string, priorToken: string | undefined, tokenHash: string, now: number) {
      return db.transaction((tx) => {
        const user = tx.select(sessionRecord).from(users)
          .where(and(eq(users.id, userId), eq(users.passwordHash, passwordHash), eq(users.active, true))).get()
        if (!user) return
        if (priorToken) tx.delete(sessions).where(eq(sessions.tokenHash, priorToken)).run()
        tx.delete(sessions).where(lte(sessions.expiresAt, now)).run()
        tx.insert(sessions).values({ tokenHash, userId, lastActiveAt: now, expiresAt: now + idleTimeout }).run()
        return user
      }, { behavior: "immediate" })
    },

    touchSession(tokenHash: string, now: number) {
      return db.transaction((tx) => {
        const user = findSession(tokenHash, now, tx)
        if (!user) return
        tx.update(sessions).set({ lastActiveAt: now, expiresAt: now + idleTimeout })
          .where(eq(sessions.tokenHash, tokenHash)).run()
        return user
      }, { behavior: "immediate" })
    },

    passwordForSession(tokenHash: string, now: number) {
      const session = findSession(tokenHash, now)
      if (!session) return
      return db.select({ id: users.id, passwordHash: users.passwordHash }).from(users)
        .where(eq(users.id, session.id)).get()
    },

    changePassword(tokenHash: string, userId: string, previous: string, passwordHash: string, replacement: string, now: number) {
      return db.transaction((tx) => {
        const session = findSession(tokenHash, now, tx)
        if (!session || session.id !== userId) return
        const changed = tx.update(users).set({ passwordHash, mustChangePassword: false })
          .where(and(eq(users.id, userId), eq(users.passwordHash, previous))).run().changes
        if (changed !== 1) return
        // The password update trigger removes all existing sessions for this user.
        tx.insert(sessions).values({
          tokenHash: replacement, userId, lastActiveAt: now, expiresAt: now + idleTimeout,
        }).run()
        tx.insert(auditLog).values({
          id: randomUUID(), actorId: userId, action: "password_changed", entity: "user", entityId: userId, occurredAt: now,
        }).run()
        return { ...session, mustChangePassword: false }
      }, { behavior: "immediate" })
    },

    deleteSession(tokenHash: string) {
      db.delete(sessions).where(eq(sessions.tokenHash, tokenHash)).run()
    },

    bootstrapUser(name: string, loginName: string, passwordHash: string, now: number) {
      return db.transaction((tx) => {
        const previous = tx.select({ id: auditLog.id }).from(auditLog)
          .where(eq(auditLog.action, "superuser_bootstrapped")).get()
        if (previous || tx.select({ id: users.id }).from(users).limit(1).get()) return false
        const id = randomUUID()
        tx.insert(users).values({ id, name, loginName, passwordHash, role: "superuser" }).run()
        tx.insert(auditLog).values({
          id: randomUUID(), actorId: id, action: "superuser_bootstrapped", entity: "user", entityId: id, occurredAt: now,
        }).run()
        return true
      }, { behavior: "immediate" })
    },
  }
}
