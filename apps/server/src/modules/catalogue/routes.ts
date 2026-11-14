import {
  listQuerySchema, lookupKindSchema, materialInputSchema, materialListSchema, materialQuerySchema,
  referenceInputSchema, referenceListSchema, supplierInputSchema, supplierListSchema,
} from "@rawmat/shared"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"
import { can } from "../auth/permissions.js"
import type { AuthAccess, AuthOptions } from "../auth/routes.js"
import { createCatalogueRepository } from "./repository.js"

const idParams = z.strictObject({ id: z.uuid() })
const archiveInput = z.strictObject({ archived: z.boolean() })
const referenceParams = z.strictObject({ kind: lookupKindSchema, id: z.uuid().optional() })
type Permission = Parameters<typeof can>[1]

export function registerCatalogue(app: FastifyInstance, auth: AuthAccess, options: AuthOptions) {
  const repository = createCatalogueRepository(options.db, options.now ?? Date.now)

  function authorize(request: FastifyRequest, reply: FastifyReply, capability: Permission, write = false) {
    const principal = auth.principal(request)
    if (!principal || principal.mustChangePassword || !can(principal.role, capability)) {
      reply.code(404).send({ error: "not_found" })
      return
    }
    const current = auth.touch(request, reply)
    if (!current || current.mustChangePassword || !can(current.role, capability)) {
      reply.code(404).send({ error: "not_found" })
      return
    }
    if (write && !auth.reserveManagementWrite(current.id, request)) {
      reply.header("Retry-After", "900").code(429).send({ error: "rate_limited" })
      return
    }
    return current
  }

  function finish(reply: FastifyReply, result: "saved" | "missing" | "duplicate" | "invalid_reference") {
    switch (result) {
      case "saved": return reply.code(204).send()
      case "missing": return reply.code(404).send({ error: "not_found" })
      case "duplicate": return reply.code(409).send({ error: "duplicate" })
      case "invalid_reference": return reply.code(400).send({ error: result })
    }
  }

  const inputError = z.toJSONSchema(z.strictObject({ error: z.string() }))
  app.get("/api/materials", {
    schema: { response: { 200: z.toJSONSchema(materialListSchema), 400: inputError, 404: inputError } },
  }, async (request, reply) => {
    const principal = authorize(request, reply, "viewWorkspace")
    if (!principal) return
    const query = materialQuerySchema.safeParse(request.query)
    if (!query.success) return reply.code(400).send({ error: "invalid_input" })
    return {
      ...repository.listMaterials(query.data),
      actions: {
        create: can(principal.role, "createOperations"),
        edit: can(principal.role, "manageRecords"),
        archive: can(principal.role, "manageRecords"),
      },
    }
  })

  async function writeMaterial(request: FastifyRequest, reply: FastifyReply, updating: boolean) {
    const principal = authorize(request, reply, updating ? "manageRecords" : "createOperations", true)
    if (!principal) return
    const id = updating ? idParams.safeParse(request.params) : undefined
    if (id && !id.success) return finish(reply, "missing")
    const input = materialInputSchema.safeParse(request.body)
    if (!input.success) return reply.code(400).send({ error: "invalid_input" })
    return finish(reply, repository.saveMaterial(principal.id, input.data, id?.data.id))
  }

  app.post("/api/materials", { bodyLimit: 16_384 }, (request, reply) => writeMaterial(request, reply, false))
  app.put("/api/materials/:id", { bodyLimit: 16_384 }, (request, reply) => writeMaterial(request, reply, true))
  app.put("/api/materials/:id/archive", { bodyLimit: 1_024 }, async (request, reply) => {
    const principal = authorize(request, reply, "manageRecords", true)
    if (!principal) return
    const id = idParams.safeParse(request.params)
    if (!id.success) return finish(reply, "missing")
    const input = archiveInput.safeParse(request.body)
    if (!input.success) return reply.code(400).send({ error: "invalid_input" })
    return finish(reply, repository.archiveMaterial(principal.id, id.data.id, input.data.archived))
  })

  app.get("/api/catalogue/:kind", {
    schema: { response: { 200: z.toJSONSchema(referenceListSchema), 400: inputError, 404: inputError } },
  }, async (request, reply) => {
    if (!authorize(request, reply, "viewWorkspace")) return
    const params = referenceParams.safeParse(request.params)
    if (!params.success) return reply.code(404).send({ error: "not_found" })
    const query = listQuerySchema.safeParse(request.query)
    if (!query.success) return reply.code(400).send({ error: "invalid_input" })
    return repository.listReferences(params.data.kind, query.data.search ?? "", query.data.page ?? 1, false)
  })

  app.get("/api/manage/catalogue/:kind", async (request, reply) => {
    if (!authorize(request, reply, "manageReferenceData")) return
    const params = referenceParams.safeParse(request.params)
    if (!params.success) return finish(reply, "missing")
    const query = listQuerySchema.safeParse(request.query)
    if (!query.success) return reply.code(400).send({ error: "invalid_input" })
    const { kind } = params.data
    const data = repository.listReferences(kind, query.data.search ?? "", query.data.page ?? 1, true)
    return (kind === "suppliers" ? supplierListSchema : referenceListSchema).parse(data)
  })

  async function writeReference(request: FastifyRequest, reply: FastifyReply) {
    const principal = authorize(request, reply, "manageReferenceData", true)
    if (!principal) return
    const params = referenceParams.safeParse(request.params)
    if (!params.success) return finish(reply, "missing")
    const { kind, id } = params.data
    const input = (kind === "suppliers" ? supplierInputSchema : referenceInputSchema).safeParse(request.body)
    if (!input.success) return reply.code(400).send({ error: "invalid_input" })
    return finish(reply, repository.saveReference(principal.id, kind, input.data, id))
  }

  app.post("/api/manage/catalogue/:kind", { bodyLimit: 16_384 }, writeReference)
  app.put("/api/manage/catalogue/:kind/:id", { bodyLimit: 16_384 }, writeReference)
}
