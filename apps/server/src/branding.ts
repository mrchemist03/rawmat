import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { join } from "node:path"
import { crc32 } from "node:zlib"
import { z } from "zod"

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

const themeSchema = z.strictObject({ primaryColor: z.string().regex(/^#[\da-fA-F]{6}$/) })
type Color = [number, number, number]

function rgb(hex: string): Color {
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)) as Color
}

function hex(color: Color) {
  return "#" + color.map((channel) => channel.toString(16).padStart(2, "0")).join("")
}

function mix(color: Color, target: number, amount: number): Color {
  return color.map((channel) => Math.round(channel * (1 - amount) + target * amount)) as Color
}

function luminance(color: Color) {
  const [red, green, blue] = color.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return red! * 0.2126 + green! * 0.7152 + blue! * 0.0722
}

function readable(color: Color, background: Color = [255, 255, 255], minimum = 4.5) {
  const backgroundLight = luminance(background)
  for (let step = 0; step <= 100; step++) {
    const candidate = mix(color, 0, step / 100)
    if ((backgroundLight + 0.05) / (luminance(candidate) + 0.05) >= minimum) return hex(candidate)
  }
  return "#000000"
}

function themeCss(primaryColor: string) {
  const color = rgb(primaryColor)
  const light = luminance(color)
  const ink = readable(color, mix(color, 255, 0.9))
  const values = {
    primary: hex(color), "primary-border": readable(color, [255, 255, 255], 3),
    "on-primary": 1.05 / (light + 0.05) >= (light + 0.05) / 0.05 ? "#ffffff" : "#000000",
    "primary-text": ink, "brand-text": ink, "brand-label": ink,
    "brand-muted": readable(mix(color, 255, 0.2), mix(color, 255, 0.94)),
    text: hex(mix(color, 0, 0.8)), line: hex(mix(color, 255, 0.82)),
    "control-line": readable(mix(color, 255, 0.55), [255, 255, 255], 3),
    "accent-line": hex(mix(color, 255, 0.4)), focus: ink,
    "page-bg": hex(mix(color, 255, 0.95)), "soft-bg": hex(mix(color, 255, 0.9)),
    "card-bg": hex(mix(color, 255, 0.97)), "hover-bg": hex(mix(color, 255, 0.94)),
    "editor-bg": hex(mix(color, 255, 0.965)), shadow: hex(color) + "20",
  }
  // Higher specificity than the bundled defaults, regardless of stylesheet loading order.
  return ":root:root{" + Object.entries(values).map(([name, value]) => "--" + name + ":" + value + ";").join("") + "}\n"
}

export async function readBrandTheme(directory: string) {
  try {
    const file = await open(join(directory, "theme.json"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size < 2 || info.size > 1024) return ""
      const data = Buffer.alloc(info.size)
      const { bytesRead } = await file.read(data, 0, data.length, 0)
      if (bytesRead !== data.length) return ""
      const theme = themeSchema.safeParse(JSON.parse(data.toString("utf8")))
      return theme.success ? themeCss(theme.data.primaryColor) : ""
    } finally {
      await file.close()
    }
  } catch {
    return ""
  }
}
