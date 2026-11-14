import {
  accountListSchema, branchListSchema, createAccountSchema, createBranchSchema, listQuerySchema,
  pageSize, updateAccountSchema, updateBranchSchema,
} from "@rawmat/shared"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"
import { can } from "../auth/permissions.js"
import type { AuthAccess, AuthOptions } from "../auth/routes.js"
import { createManagementRepository } from "./repository.js"

const idSchema = z.strictObject({ id: z.uuid() })

export function registerManagement(app: FastifyInstance, auth: AuthAccess, options: AuthOptions) {
  const repository = createManagementRepository(options.db, options.now ?? Date.now)
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "not_found" })
  const invalid = (reply: FastifyReply) => reply.code(400).send({ error: "invalid_input" })

  function permitted(request: FastifyRequest, permission: "manageAccounts" | "manageBranches") {
    const principal = auth.principal(request)
    if (!principal || principal.mustChangePassword || !can(principal.role, permission)) {
      return
    }
    return principal
  }

  function authorize(request: FastifyRequest, reply: FastifyReply, permission: "manageAccounts" | "manageBranches") {
    if (!permitted(request, permission)) {
      notFound(reply)
      return
    }
    const current = auth.touch(request, reply)
    if (!current || current.mustChangePassword || !can(current.role, permission)) {
      notFound(reply)
      return
    }
    return current
  }

  function reserveWrite(request: FastifyRequest, reply: FastifyReply, actorId: string) {
    if (auth.reserveManagementWrite(actorId, request)) return true
    reply.header("Retry-After", "900").code(429).send({ error: "rate_limited" })
    return false
  }

  function finishWrite(reply: FastifyReply, result: ReturnType<typeof repository.saveAccount>) {
    if (result === "saved") return reply.code(204).send()
    if (result === "missing") return notFound(reply)
    return reply.code(result === "invalid_branch" ? 400 : 409).send({ error: result })
  }

  const queryError = z.toJSONSchema(z.strictObject({ error: z.string() }))
  app.get("/api/manage/accounts", {
    schema: { response: { 200: z.toJSONSchema(accountListSchema), 400: queryError, 404: queryError } },
  }, async (request, reply) => {
    const principal = authorize(request, reply, "manageAccounts")
    if (!principal) return
    const result = listQuerySchema.safeParse(request.query)
    if (!result.success) return invalid(reply)
    const { page = 1, search = "" } = result.data
    return repository.listAccounts(principal.id, search, pageSize, (page - 1) * pageSize)
  })

  app.get("/api/manage/branches", {
    schema: { response: { 200: z.toJSONSchema(branchListSchema), 400: queryError, 404: queryError } },
  }, async (request, reply) => {
    if (!authorize(request, reply, "manageBranches")) return
    const result = listQuerySchema.safeParse(request.query)
    if (!result.success) return invalid(reply)
    const { page = 1, search = "" } = result.data
    return repository.listBranches(search, pageSize, (page - 1) * pageSize)
  })

  async function writeAccount(request: FastifyRequest, reply: FastifyReply, updating: boolean) {
    const principal = authorize(request, reply, "manageAccounts")
    if (!principal) return
    const id = updating ? idSchema.safeParse(request.params) : undefined
    if (id && !id.success) return notFound(reply)
    const input = (updating ? updateAccountSchema : createAccountSchema).safeParse(request.body)
    if (!input.success) return invalid(reply)
    if (!reserveWrite(request, reply, principal.id)) return
    const { temporaryPassword, ...fields } = input.data
    const passwordHash = temporaryPassword ? await auth.hashTemporaryPassword(temporaryPassword) : undefined
    if (temporaryPassword && !passwordHash) {
      return reply.header("Retry-After", "2").code(503).send({ error: "try_later" })
    }
    // The session may have been revoked while hashing the password.
    if (temporaryPassword && !permitted(request, "manageAccounts")) return notFound(reply)
    return finishWrite(reply, repository.saveAccount(principal.id, fields, passwordHash, id?.data.id))
  }

  function writeBranch(request: FastifyRequest, reply: FastifyReply, updating: boolean) {
    const principal = authorize(request, reply, "manageBranches")
    if (!principal) return
    const id = updating ? idSchema.safeParse(request.params) : undefined
    if (id && !id.success) return notFound(reply)
    const input = (updating ? updateBranchSchema : createBranchSchema).safeParse(request.body)
    if (!input.success) return invalid(reply)
    if (!reserveWrite(request, reply, principal.id)) return
    return finishWrite(reply, repository.saveBranch(principal.id, input.data, id?.data.id))
  }

  app.post("/api/manage/accounts", { bodyLimit: 4_096 }, (request, reply) => writeAccount(request, reply, false))
  app.put("/api/manage/accounts/:id", { bodyLimit: 4_096 }, (request, reply) => writeAccount(request, reply, true))
  app.post("/api/manage/branches", { bodyLimit: 4_096 }, async (request, reply) => writeBranch(request, reply, false))
  app.put("/api/manage/branches/:id", { bodyLimit: 4_096 }, async (request, reply) => writeBranch(request, reply, true))
}
