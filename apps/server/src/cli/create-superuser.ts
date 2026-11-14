import { StringDecoder } from "node:string_decoder"
import { loginNameSchema, newPasswordSchema } from "@rawmat/shared"
import { z } from "zod"
import { openDatabase } from "../db/database.js"
import { hashPassword } from "../modules/auth/passwords.js"
import { createAuthRepository } from "../modules/auth/repository.js"

function readHidden(label: string): Promise<string> {
  const input = process.stdin
  if (!input.isTTY) throw new Error("A terminal is required to enter the password securely.")
  process.stderr.write(label)
  return new Promise((resolve, reject) => {
    let password = ""
    const decoder = new StringDecoder("utf8")
    const finish = (cancelled: boolean) => {
      input.removeListener("data", read)
      input.setRawMode(false)
      input.pause()
      process.stderr.write("\n")
      if (cancelled) reject(new Error("Password entry cancelled."))
      else resolve(password)
    }
    const read = (value: Buffer) => {
      for (const char of decoder.write(value)) {
        if (char === "\u0003" || char === "\u0004" || char === "\u001b") return finish(true)
        if (char === "\r" || char === "\n") return finish(false)
        if (char === "\u007f" || char === "\b") password = [...password].slice(0, -1).join("")
        else if (char >= " ") {
          password += char
          if (password.length > 128) return finish(true)
        }
      }
    }
    input.setRawMode(true)
    input.on("data", read)
    input.resume()
  })
}

const args = z.tuple([loginNameSchema, z.string().trim().min(1).max(120)]).safeParse(process.argv.slice(2))
try {
  if (!args.success) throw new Error("Usage: create-superuser <login-name> <display-name>")
  process.umask(0o077)
  const [loginName, name] = args.data
  const password = await readHidden("Temporary password: ")
  if (!newPasswordSchema.safeParse(password).success) throw new Error("Use 12–128 characters.")
  if (password !== await readHidden("Repeat temporary password: ")) throw new Error("Passwords differ.")
  const passwordHash = await hashPassword(password)
  // Start the server first so there is a single owner for schema migrations.
  const database = openDatabase(process.env.DATABASE_PATH || "./data/rawmat.sqlite", false)
  try {
    if (!createAuthRepository(database.db).bootstrapUser(name, loginName, passwordHash, Date.now())) {
      console.error("The first account has already been initialized.")
      process.exitCode = 1
    } else {
      console.log("Account created. Set a new password at first sign-in.")
    }
  } finally {
    database.close()
  }
} catch (error) {
  console.error(error instanceof Error && (
    !args.success || /^(A terminal|Password entry|Use 12|Passwords differ)/.test(error.message)
  ) ? error.message : "Account creation failed. Start the app and verify database access.")
  process.exitCode = 1
}
