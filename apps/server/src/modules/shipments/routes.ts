import {
  listQuerySchema, purchaseBranchListSchema, shipmentDetailSchema, shipmentIdSchema, shipmentInputSchema,
  shipmentListSchema, shipmentQuerySchema, shipmentReceiptSchema, shipmentUpdateSchema,
  trackingNumberSchema,
} from "@rawmat/shared"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { can } from "../auth/permissions.js"
import type { AuthAccess, AuthOptions } from "../auth/routes.js"
import { listActiveBranches } from "../inventory/repository.js"
import { createShipmentRepository } from "./repository.js"

export function registerShipments(app: FastifyInstance, auth: AuthAccess, options: AuthOptions) {
  const repository = createShipmentRepository(options.db, options.now ?? Date.now)
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
    return { id: current.id, branchId: current.branchId, manage: can(current.role, "manageRecords") }
  }

  function finish(reply: FastifyReply, result: string) {
    if (result === "saved") return reply.code(204).send()
    if (result === "missing") return notFound(reply)
    const failedValidation = ["invalid_shipment_reference", "invalid_shipment_receipt"].includes(result)
    return reply.code(failedValidation ? 400 : 409).send({ error: result })
  }

  app.get("/api/shipments", async (request, reply) => {
    if (!authorize(request, reply)) return
    const query = shipmentQuerySchema.safeParse(request.query)
    if (!query.success) return invalid(reply)
    return shipmentListSchema.parse(repository.list(query.data))
  })

  app.get("/api/shipments/branches", async (request, reply) => {
    if (!authorize(request, reply)) return
    const query = listQuerySchema.safeParse(request.query)
    if (!query.success) return invalid(reply)
    return purchaseBranchListSchema.parse(listActiveBranches(options.db, query.data.search ?? "", query.data.page ?? 1))
  })

  app.get("/api/shipments/tracking/:number", async (request, reply) => {
    if (!authorize(request, reply)) return
    const input = trackingNumberSchema.safeParse((request.params as { number?: unknown }).number)
    const result = input.success && repository.findByTrackingNumber(input.data)
    return result ? shipmentIdSchema.parse(result) : notFound(reply)
  })

  app.get("/api/shipments/:id", async (request, reply) => {
    const actor = authorize(request, reply)
    if (!actor) return
    const params = shipmentIdSchema.safeParse(request.params)
    if (!params.success) return notFound(reply)
    const detail = repository.detail(actor, params.data.id)
    return detail ? shipmentDetailSchema.parse(detail) : notFound(reply)
  })

  app.post("/api/shipments", { bodyLimit: 131_072 }, async (request, reply) => {
    const actor = authorize(request, reply, true)
    if (!actor) return
    const input = shipmentInputSchema.safeParse(request.body)
    if (!input.success) return invalid(reply)
    const result = repository.create(actor, input.data)
    if (typeof result === "string") return finish(reply, result)
    return reply.header("Location", `/api/shipments/${result.id}`)
      .code(result.duplicate ? 200 : 201).send(shipmentIdSchema.parse({ id: result.id }))
  })

  app.post("/api/shipments/:id/tracking", { bodyLimit: 8_192 }, async (request, reply) => {
    const actor = authorize(request, reply, true)
    if (!actor) return
    const params = shipmentIdSchema.safeParse(request.params)
    if (!params.success) return notFound(reply)
    const input = shipmentUpdateSchema.safeParse(request.body)
    if (!input.success) return invalid(reply)
    return finish(reply, repository.update(actor, params.data.id, input.data))
  })

  app.post("/api/shipments/:id/receipt", { bodyLimit: 65_536 }, async (request, reply) => {
    const actor = authorize(request, reply, true)
    if (!actor) return
    const params = shipmentIdSchema.safeParse(request.params)
    if (!params.success) return notFound(reply)
    const input = shipmentReceiptSchema.safeParse(request.body)
    if (!input.success) return invalid(reply)
    return finish(reply, repository.receive(actor, params.data.id, input.data))
  })
}
