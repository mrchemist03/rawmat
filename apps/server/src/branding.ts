import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { join } from "node:path"
import { crc32 } from "node:zlib"

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const maxBytes = 512 * 1024

function isPng(data: Buffer) {
  if (!data.subarray(0, 8).equals(signature) || data.readUInt32BE(8) !== 13 ||
    data.toString("ascii", 12, 16) !== "IHDR") return false
  const width = data.readUInt32BE(16)
  const height = data.readUInt32BE(20)
  if (!width || !height || width > 2048 || height > 2048) return false

  let hasImageData = false
  for (let offset = 8; offset + 12 <= data.length;) {
    const length = data.readUInt32BE(offset)
    const checksum = offset + 8 + length
    if (checksum + 4 > data.length ||
      crc32(data.subarray(offset + 4, checksum)) !== data.readUInt32BE(checksum)) return false
    const type = data.toString("ascii", offset + 4, offset + 8)
    if (type === "IDAT" && length) hasImageData = true
    if (type === "IEND") return hasImageData && length === 0 && checksum + 4 === data.length
    offset = checksum + 4
  }
  return false
}

export async function readBrandLogo(directory: string) {
  const path = join(directory, "logo.png")
  try {
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size < 45 || info.size > maxBytes) return
      const data = Buffer.alloc(info.size)
      const { bytesRead } = await file.read(data, 0, data.length, 0)
      if (bytesRead === data.length && isPng(data)) return data
    } finally {
      await file.close()
    }
  } catch {
    return undefined
  }
}
