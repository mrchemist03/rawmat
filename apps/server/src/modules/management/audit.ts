import { auditListSchema, listQuerySchema, pageSize } from "@rawmat/shared"
import { count, desc, eq, sql } from "drizzle-orm"
import type { FastifyInstance } from "fastify"
import type { AppDatabase } from "../../db/database.js"
import { auditLog, users } from "../../db/schema.js"
import { can } from "../auth/permissions.js"
import type { AuthAccess } from "../auth/routes.js"

export function registerAudit(app: FastifyInstance, auth: AuthAccess, db: AppDatabase) {
  app.get("/api/manage/audit", async (request, reply) => {
    const principal = auth.principal(request)
    if (!principal || principal.mustChangePassword || !can(principal.role, "viewAudit")) {
      return reply.code(404).send({ error: "not_found" })
    }
    const parsed = listQuerySchema.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input" })
    auth.touch(request, reply)
    const { search = "", page = 1 } = parsed.data
    const filter = search ? sql`instr(${auditLog.action}, ${search}) > 0 or instr(${auditLog.entityId}, ${search}) > 0` : undefined
    const items = db.select({
      id: auditLog.id, actorName: users.name, action: auditLog.action, entity: auditLog.entity,
      entityId: auditLog.entityId, occurredAt: auditLog.occurredAt, before: auditLog.before, after: auditLog.after,
    }).from(auditLog).leftJoin(users, eq(auditLog.actorId, users.id)).where(filter)
      .orderBy(desc(auditLog.occurredAt), desc(auditLog.id)).limit(pageSize).offset((page - 1) * pageSize).all()
    const total = db.select({ count: count() }).from(auditLog).where(filter).get()?.count ?? 0
    return auditListSchema.parse({ items, total })
  })
}
