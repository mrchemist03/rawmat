import { randomUUID } from "node:crypto"
import { and, asc, count, eq, ne, sql } from "drizzle-orm"
import type { AccountType } from "@rawmat/shared"
import type { AppDatabase } from "../../db/database.js"
import { auditLog, branches, users } from "../../db/schema.js"

type AccountInput = {
  name: string
  loginName: string
  branchId: string | null
  active?: boolean
  accountType?: AccountType
}
type BranchInput = { name: string; city: string; active?: boolean }
type WriteResult = "saved" | "missing" | "duplicate" | "invalid_branch" | "protected_account"

export function createManagementRepository(db: AppDatabase, now: () => number) {
  function audit(tx: Pick<AppDatabase, "insert">, actorId: string, action: string, entity: string, entityId: string) {
    tx.insert(auditLog).values({ id: randomUUID(), actorId, action, entity, entityId, occurredAt: now() }).run()
  }

  return {
    listAccounts(actorId: string, search: string, limit: number, offset: number) {
      const filter = sql`instr(${users.name}, ${search}) > 0 or instr(${users.loginName}, ${search.toLowerCase()}) > 0`
      const fields = {
        id: users.id, name: users.name, loginName: users.loginName, active: users.active,
        branchId: users.branchId, branchName: branches.name,
      }
      const items = db.select(fields).from(users).leftJoin(branches, eq(users.branchId, branches.id))
        .where(filter).orderBy(asc(users.name), asc(users.id)).limit(limit).offset(offset).all()
      const total = db.select({ total: count() }).from(users).where(filter).get()?.total ?? 0
      return { items: items.map((item) => ({ ...item, isCurrentAccount: item.id === actorId })), total }
    },

    listBranches(search: string, limit: number, offset: number) {
      const filter = sql`instr(${branches.name}, ${search}) > 0 or instr(${branches.city}, ${search}) > 0`
      const items = db.select().from(branches).where(filter)
        .orderBy(asc(branches.name), asc(branches.id)).limit(limit).offset(offset).all()
      const total = db.select({ total: count() }).from(branches).where(filter).get()?.total ?? 0
      return { items, total }
    },

    saveAccount(actorId: string, input: AccountInput, passwordHash: string | undefined, id?: string): WriteResult {
      return db.transaction((tx) => {
        const existing = id ? tx.select({ branchId: users.branchId }).from(users).where(eq(users.id, id)).get() : undefined
        if (id && !existing) return "missing"
        if (id === actorId && (input.active === false || input.accountType || passwordHash)) return "protected_account"
        const loginMatch = tx.select({ id: users.id }).from(users).where(eq(users.loginName, input.loginName)).get()
        if (loginMatch && loginMatch.id !== id) return "duplicate"
        if (input.branchId && input.branchId !== existing?.branchId) {
          const branch = tx.select({ id: branches.id }).from(branches)
            .where(and(eq(branches.id, input.branchId), eq(branches.active, true))).get()
          if (!branch) return "invalid_branch"
        }

        const fields = { name: input.name, loginName: input.loginName, branchId: input.branchId }
        if (id) {
          tx.update(users).set({
            ...fields, active: input.active, role: input.accountType,
            passwordHash, mustChangePassword: passwordHash ? true : undefined,
          }).where(eq(users.id, id)).run()
          audit(tx, actorId, "account_updated", "user", id)
        } else {
          if (!passwordHash || !input.accountType) throw new Error("Incomplete account creation")
          const accountId = randomUUID()
          tx.insert(users).values({ ...fields, id: accountId, role: input.accountType, passwordHash }).run()
          audit(tx, actorId, "account_created", "user", accountId)
        }
        return "saved"
      }, { behavior: "immediate" })
    },

    saveBranch(actorId: string, input: BranchInput, id?: string): WriteResult {
      return db.transaction((tx) => {
        if (id && !tx.select({ id: branches.id }).from(branches).where(eq(branches.id, id)).get()) return "missing"
        const duplicateFilter = id ? and(eq(branches.name, input.name), ne(branches.id, id)) : eq(branches.name, input.name)
        if (tx.select({ id: branches.id }).from(branches).where(duplicateFilter).get()) return "duplicate"
        const branchId = id ?? randomUUID()
        if (id) tx.update(branches).set(input).where(eq(branches.id, id)).run()
        else tx.insert(branches).values({ ...input, id: branchId }).run()
        audit(tx, actorId, id ? "branch_updated" : "branch_created", "branch", branchId)
        return "saved"
      }, { behavior: "immediate" })
    },
  }
}
