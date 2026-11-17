import type { FastifyReply, FastifyRequest } from "fastify"
import { csvLimit } from "@rawmat/shared"
import type { AuthAccess } from "../auth/routes.js"

export const exportRowLimit = 5000
type Cell = string | number | boolean | null | undefined
const formula = /^[\s\uFEFF\u200B-\u200F\u202A-\u202E\u2066-\u2069]*[=+\-@＝＋－＠]/u

function csvCell(value: Cell) {
  const text = String(value ?? "")
  const safe = typeof value === "string" && (formula.test(text) || /^[\t\r\n]/u.test(text)) ? "'" + text : text
  return '"' + safe.replaceAll('"', '""') + '"'
}

export function allowExport(auth: AuthAccess, id: string, request: FastifyRequest, reply: FastifyReply) {
  if (auth.reserveExport(id, request)) return true
  reply.header("Retry-After", "60").code(429).send({ error: "rate_limited" })
  return false
}

export function sendCsv(reply: FastifyReply, filename: string, headers: readonly string[], rows: Iterable<readonly Cell[]>) {
  const lines = ["\uFEFF" + headers.map(csvCell).join(",") + "\r\n"]
  let length = Buffer.byteLength(lines[0]!)
  for (const row of rows) {
    const line = row.map(csvCell).join(",") + "\r\n"
    length += Buffer.byteLength(line)
    if (lines.length > exportRowLimit || length > csvLimit) {
      return reply.code(413).send({ error: "export_too_large" })
    }
    lines.push(line)
  }
  return reply.type("text/csv; charset=utf-8").header("Content-Disposition", 'attachment; filename="' + filename + '"')
    .send(lines.join(""))
}
