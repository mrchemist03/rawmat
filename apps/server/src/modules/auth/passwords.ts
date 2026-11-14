import { argon2, randomBytes, timingSafeEqual } from "node:crypto"

const parameters = { parallelism: 1, tagLength: 32, memory: 64 * 1024, passes: 3 }
const format = "$argon2id$v=19$m=65536,t=3,p=1$"
const encodedHash = /^\$argon2id\$v=19\$m=65536,t=3,p=1\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/

function derive(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    argon2("argon2id", { ...parameters, message: password, nonce: salt }, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16)
  const hash = await derive(password, salt)
  const encode = (value: Buffer) => value.toString("base64").replace(/=+$/, "")
  return `${format}${encode(salt)}$${encode(hash)}`
}

export async function verifyPassword(password: string, hash: string) {
  const fields = encodedHash.exec(hash)
  if (!fields?.[1] || !fields[2]) return false
  const actual = await derive(password, Buffer.from(fields[1], "base64"))
  return timingSafeEqual(actual, Buffer.from(fields[2], "base64"))
}
