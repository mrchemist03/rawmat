import { auditActionLabel, auditEntityLabels, auditListSchema, auditQuerySchema, pageSize } from "@rawmat/shared"
import { and, count, desc, eq, gte, lt, sql } from "drizzle-orm"
import type { FastifyInstance } from "fastify"
import type { AppDatabase } from "../../db/database.js"
import { auditLog, users } from "../../db/schema.js"
import { can } from "../auth/permissions.js"
import type { AuthAccess } from "../auth/routes.js"
import { allowExport, exportRowLimit, sendCsv } from "../reporting/csv.js"

const day = 86_400_000

export function registerAudit(app: FastifyInstance, auth: AuthAccess, db: AppDatabase) {
  for (const exporting of [false, true]) app.get("/api/manage/audit" + (exporting ? "/export" : ""), async (request, reply) => {
    const principal = auth.touch(request, reply)
    if (!principal || principal.mustChangePassword || !can(principal.role, "viewAudit")) {
      return reply.code(404).send({ error: "not_found" })
    }
    const parsed = auditQuerySchema.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input" })
    if (exporting && !allowExport(auth, principal.id, request, reply)) return
    const { search = "", page = 1, entity, from, to } = parsed.data
    const filter = and(
      entity ? eq(auditLog.entity, entity) : undefined,
      from ? gte(auditLog.occurredAt, Date.parse(from)) : undefined,
      to ? lt(auditLog.occurredAt, Date.parse(to) + day) : undefined,
      search ? sql`(instr(lower(${auditLog.action}), lower(${search})) > 0 or
        instr(lower(${auditLog.entityId}), lower(${search})) > 0 or instr(lower(${users.name}), lower(${search})) > 0)` : undefined,
    )
    const items = db.select({
      id: auditLog.id, actorName: users.name, action: auditLog.action, entity: auditLog.entity,
      entityId: auditLog.entityId, occurredAt: auditLog.occurredAt, before: auditLog.before, after: auditLog.after,
    }).from(auditLog).leftJoin(users, eq(auditLog.actorId, users.id)).where(filter)
      .orderBy(desc(auditLog.occurredAt), desc(auditLog.id)).limit(exporting ? exportRowLimit + 1 : pageSize)
      .offset(exporting ? 0 : (page - 1) * pageSize).all()
    if (exporting) return sendCsv(reply, "audit.csv", ["وقت العملية (UTC)", "الاسم", "الإجراء", "نوع السجل", "معرّف السجل", "قبل", "بعد"],
      items.map((item) => [new Date(item.occurredAt).toISOString(), item.actorName ?? "النظام", auditActionLabel(item.action),
        Object.hasOwn(auditEntityLabels, item.entity) ? auditEntityLabels[item.entity as keyof typeof auditEntityLabels] : item.entity,
        item.entityId, item.before ? JSON.stringify(item.before) : "", item.after ? JSON.stringify(item.after) : ""]))
    const total = db.select({ count: count() }).from(auditLog).leftJoin(users, eq(auditLog.actorId, users.id))
      .where(filter).get()?.count ?? 0
    return auditListSchema.parse({ items, total })
  })
}
