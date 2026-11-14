import {
  listQuerySchema, purchaseBranchListSchema, purchaseDetailSchema, purchaseIdSchema, purchaseInputSchema,
  purchaseListSchema, purchaseQuerySchema, purchaseTransitionSchema, purchaseUpdateSchema,
} from "@rawmat/shared"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { can } from "../auth/permissions.js"
import type { AuthAccess, AuthOptions } from "../auth/routes.js"
import { createPurchaseRepository } from "./repository.js"

export function registerPurchases(app: FastifyInstance, auth: AuthAccess, options: AuthOptions) {
  const repository = createPurchaseRepository(options.db, options.now ?? Date.now)
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "not_found" })
  const invalid = (reply: FastifyReply) => reply.code(400).send({ error: "invalid_input" })

  function authorize(request: FastifyRequest, reply: FastifyReply, write = false) {
    const permission = write ? "createOperations" : "viewWorkspace"
    const session = auth.principal(request)
    if (!session || session.mustChangePassword || !can(session.role, permission)) {
      notFound(reply)
      return
    }
    const current = auth.touch(request, reply)
    if (!current || current.mustChangePassword || !can(current.role, permission)) {
      notFound(reply)
      return
    }
    if (write && !auth.reserveManagementWrite(current.id, request)) {
      reply.header("Retry-After", "900").code(429).send({ error: "rate_limited" })
      return
    }
    return { id: current.id, canCreate: can(current.role, "createOperations"), canManage: can(current.role, "manageRecords") }
  }

  function finish(reply: FastifyReply, result: ReturnType<typeof repository.update>) {
    if (result === "saved") return reply.code(204).send()
    if (result === "missing") return notFound(reply)
    return reply.code(result === "invalid_purchase_reference" ? 400 : 409).send({ error: result })
  }

  app.get("/api/purchases", async (request, reply) => {
    const actor = authorize(request, reply)
    if (!actor) return
    const query = purchaseQuerySchema.safeParse(request.query)
    if (!query.success) return invalid(reply)
    return purchaseListSchema.parse(repository.list(actor, query.data))
  })

  app.get("/api/purchases/branches", async (request, reply) => {
    if (!authorize(request, reply)) return
    const query = listQuerySchema.safeParse(request.query)
    if (!query.success) return invalid(reply)
    return purchaseBranchListSchema.parse(repository.listBranches(query.data.search ?? "", query.data.page ?? 1))
  })

  app.get("/api/purchases/:id", async (request, reply) => {
    const actor = authorize(request, reply)
    if (!actor) return
    const params = purchaseIdSchema.safeParse(request.params)
    if (!params.success) return notFound(reply)
    const result = repository.detail(actor, params.data.id)
    return result ? purchaseDetailSchema.parse(result) : notFound(reply)
  })

  app.post("/api/purchases", { bodyLimit: 32_768 }, async (request, reply) => {
    const actor = authorize(request, reply, true)
    if (!actor) return
    const input = purchaseInputSchema.safeParse(request.body)
    if (!input.success) return invalid(reply)
    const result = repository.create(actor, input.data)
    if (typeof result === "string") return finish(reply, result)
    return reply.header("Location", `/api/purchases/${result.id}`).code(201).send(purchaseIdSchema.parse(result))
  })

  app.put("/api/purchases/:id", { bodyLimit: 32_768 }, async (request, reply) => {
    const actor = authorize(request, reply, true)
    if (!actor) return
    const params = purchaseIdSchema.safeParse(request.params)
    if (!params.success) return notFound(reply)
    const input = purchaseUpdateSchema.safeParse(request.body)
    if (!input.success) return invalid(reply)
    const { revision, ...fields } = input.data
    return finish(reply, repository.update(actor, params.data.id, fields, revision))
  })

  app.post("/api/purchases/:id/transition", { bodyLimit: 1_024 }, async (request, reply) => {
    const actor = authorize(request, reply, true)
    if (!actor) return
    const params = purchaseIdSchema.safeParse(request.params)
    if (!params.success) return notFound(reply)
    const input = purchaseTransitionSchema.safeParse(request.body)
    if (!input.success) return invalid(reply)
    return finish(reply, repository.transition(actor, params.data.id, input.data.status, input.data.revision))
  })
}
