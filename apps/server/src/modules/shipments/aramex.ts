import { shipmentStatus, trackingNumberSchema } from "@rawmat/shared"
import type { ShipmentStatus } from "@rawmat/shared"
import { SaxesParser } from "saxes"
import { z } from "zod"
import { trackingResultSchema } from "./tracking.js"
import type { TrackingProvider, TrackingResult } from "./tracking.js"

const endpoint = "https://ws.aramex.net/ShippingAPI.V2/Tracking/Service_1_0.svc"
const soap = "http://schemas.xmlsoap.org/soap/envelope/"
const aramex = "http://ws.aramex.net/ShippingAPI/v1/"
const arrays = "http://schemas.microsoft.com/2003/10/Serialization/Arrays"
const schemaInstance = "http://www.w3.org/2001/XMLSchema-instance"
const responseLimit = 1024 * 1024
const codePattern = /^[A-Z0-9_.:-]{1,80}$/
const offsetPattern = /^[+-](?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00)$/
const dateWithOffset = z.iso.datetime({ offset: true })
const localDate = z.iso.datetime({ local: true })

export type AramexConfig = {
  clientInfo: {
    UserName: string
    Password: string
    Version: string
    AccountNumber: string
    AccountPin: string
    AccountEntity: string
    AccountCountryCode: string
  }
  utcOffset?: string
  statusMap: Record<string, ShipmentStatus>
}

const credential = z.string().min(1).max(256).refine((value) =>
  value.trim().length > 0 && !/[\x00-\x1f\x7f]/u.test(value))

export function readAramexConfig(env: NodeJS.ProcessEnv): AramexConfig {
  const clientInfo = z.object({
    UserName: credential, Password: credential, Version: z.string().regex(/^v\d{1,2}(?:\.\d{1,2})?$/i),
    AccountNumber: z.string().regex(/^\d{1,32}$/), AccountPin: credential,
    AccountEntity: z.string().regex(/^[A-Z0-9]{2,10}$/), AccountCountryCode: z.string().regex(/^[A-Z]{2}$/),
  }).safeParse({
    UserName: env.ARAMEX_USERNAME, Password: env.ARAMEX_PASSWORD, Version: env.ARAMEX_API_VERSION || "v1",
    AccountNumber: env.ARAMEX_ACCOUNT_NUMBER, AccountPin: env.ARAMEX_ACCOUNT_PIN,
    AccountEntity: env.ARAMEX_ACCOUNT_ENTITY, AccountCountryCode: env.ARAMEX_ACCOUNT_COUNTRY_CODE,
  })
  if (!clientInfo.success) throw new Error("Aramex account settings are incomplete or invalid")
  const utcOffset = env.ARAMEX_EVENT_UTC_OFFSET || undefined
  if (utcOffset && !offsetPattern.test(utcOffset)) throw new Error("Invalid ARAMEX_EVENT_UTC_OFFSET")
  let statusMap: Record<string, ShipmentStatus> = {}
  if (env.ARAMEX_STATUS_MAP) {
    try {
      if (env.ARAMEX_STATUS_MAP.length > 8192) throw new Error()
      statusMap = z.record(z.string().regex(codePattern), shipmentStatus).parse(JSON.parse(env.ARAMEX_STATUS_MAP))
    } catch {
      throw new Error("Invalid ARAMEX_STATUS_MAP")
    }
  }
  return { clientInfo: clientInfo.data, utcOffset, statusMap }
}

const xmlEscapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }

function escape(value: string) {
  return value.replace(/[&<>"']/g, (character) => xmlEscapes[character]!)
}

function requestBody(config: AramexConfig, awbs: string[]) {
  const account = Object.entries(config.clientInfo)
    .map(([name, value]) => "<" + name + ">" + escape(value) + "</" + name + ">").join("")
  const shipments = awbs.map((awb) => "<a:string>" + escape(awb) + "</a:string>").join("")
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="' + soap + '" xmlns:a="' + arrays + '"><s:Body>' +
    '<ShipmentTrackingRequest xmlns="' + aramex + '"><ClientInfo>' + account + '</ClientInfo>' +
    '<Shipments>' + shipments + '</Shipments><GetLastTrackingUpdateOnly>false</GetLastTrackingUpdateOnly>' +
    '<GetUpdateTimeZone>true</GetUpdateTimeZone>' +
    '</ShipmentTrackingRequest></s:Body></s:Envelope>'
}

type Element = { local: string; uri: string; text: string; children: Element[]; nil: boolean }

function parseXml(input: string) {
  const parser = new SaxesParser({ xmlns: true })
  const stack: Element[] = []
  let root: Element | undefined
  let size = 0
  parser.on("doctype", () => { throw new Error("Invalid Aramex XML") })
  parser.on("error", () => { throw new Error("Invalid Aramex XML") })
  parser.on("opentag", ({ local, uri, attributes }) => {
    if (++size > 25_000 || stack.length >= 16) throw new Error("Invalid Aramex XML")
    const nil = Object.values(attributes).some((attribute) =>
      attribute.uri === schemaInstance && attribute.local === "nil" && ["true", "1"].includes(attribute.value))
    const node: Element = { local, uri, text: "", children: [], nil }
    const parent = stack.at(-1)
    if (parent) parent.children.push(node)
    else root = node
    stack.push(node)
  })
  parser.on("closetag", () => { stack.pop() })
  function append(value: string) {
    const node = stack.at(-1)
    if (node) node.text += value
  }
  parser.on("text", append)
  parser.on("cdata", append)
  parser.write(input).close()
  return root
}

function children(node: Element | undefined, uri: string, local: string) {
  return node?.children.filter((child) => child.local === local && child.uri === uri) ?? []
}

function one(node: Element | undefined, uri: string, local: string) {
  const matches = children(node, uri, local)
  if (matches.length > 1) throw new Error("Malformed Aramex response")
  return matches[0]
}

const descriptions = new Map<string, ShipmentStatus>([
  ["shipment information received", "registered"], ["shipment created", "registered"],
  ["picked up", "picked_up"], ["shipment picked up", "picked_up"], ["استلمها الناقل", "picked_up"],
  ["in transit", "in_transit"], ["shipment in transit", "in_transit"], ["في الطريق", "in_transit"],
  ["out for delivery", "out_for_delivery"], ["shipment out for delivery", "out_for_delivery"], ["خرجت للتوصيل", "out_for_delivery"],
  ["delivered", "delivered"], ["shipment delivered", "delivered"], ["shipment has been delivered", "delivered"], ["تم التسليم", "delivered"],
  ["delivery attempted", "exception"], ["delivery failed", "exception"], ["تعذر التسليم", "exception"],
  ["returned to sender", "returned"], ["shipment returned to sender", "returned"], ["تم الإرجاع إلى المرسل", "returned"],
])

function trackingEvent(row: Element, awb: string, config: AramexConfig) {
  const field = (name: string) => one(row, aramex, name)?.text.trim() ?? ""
  const waybill = trackingNumberSchema.safeParse(field("WaybillNumber"))
  const code = field("UpdateCode").toUpperCase()
  const description = field("UpdateDescription")
  const location = field("UpdateLocation")
  const timestamp = field("UpdateDateTime")
  const reportedOffset = field("UpdateTimeZone").toUpperCase().replace(/^(?:GMT|UTC)/, "")
  const offset = offsetPattern.test(reportedOffset) ? reportedOffset : config.utcOffset
  const qualified = dateWithOffset.safeParse(timestamp).success ? timestamp :
    offset && localDate.safeParse(timestamp).success ? timestamp + offset : ""
  if (!waybill.success || waybill.data !== awb || !codePattern.test(code) || !qualified) throw new Error("Invalid tracking event")
  const normalized = description.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").replace(/[.!。]+$/u, "").trim()
  const status = Object.hasOwn(config.statusMap, code) ? config.statusMap[code]! : descriptions.get(normalized) ?? null
  return {
    status, code, description: description.slice(0, 500) || code, location: location.slice(0, 120),
    occurredAt: Date.parse(qualified),
    raw: JSON.stringify({ code, timestamp, timezone: field("UpdateTimeZone").slice(0, 64) }),
  }
}

function trackingResponse(xml: string, requested: string[], config: AramexConfig) {
  const root = parseXml(xml)
  if (root?.local !== "Envelope" || root.uri !== soap) throw new Error("Invalid SOAP envelope")
  const body = one(root, soap, "Body")
  if (one(body, soap, "Fault")) throw new Error("Aramex SOAP fault")
  const response = one(body, aramex, "ShipmentTrackingResponse")
  const hasErrors = one(response, aramex, "HasErrors")?.text.trim()
  const dictionary = one(response, aramex, "TrackingResults")
  if (!dictionary || dictionary.nil || (hasErrors !== undefined && hasErrors !== "false" && hasErrors !== "0")) {
    throw new Error("Aramex tracking request failed")
  }
  const seen = new Set<string>()
  const results: TrackingResult[] = []
  for (const item of children(dictionary, arrays, "KeyValueOfstringArrayOfTrackingResultmFAkxlpY")) {
    const key = trackingNumberSchema.safeParse(one(item, arrays, "Key")?.text)
    if (!key.success || !requested.includes(key.data) || seen.has(key.data)) throw new Error("Unexpected Aramex tracking number")
    const awb = key.data
    seen.add(awb)
    const value = one(item, arrays, "Value")
    if (!value || value.nil) continue
    try {
      const rows = children(value, aramex, "TrackingResult")
      const events = rows.map((row) => trackingEvent(row, awb, config))
        .sort((first, second) => second.occurredAt - first.occurredAt).slice(0, 100)
      results.push(trackingResultSchema.parse({ awb, events }))
    } catch {
      // Other waybills in the same batch can still be saved.
    }
  }
  return results
}

async function readResponse(response: Response) {
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > responseLimit) {
    await response.body?.cancel()
    throw new Error("Aramex tracking request failed")
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > responseLimit) {
      await reader.cancel()
      throw new Error("Aramex response exceeds size limit")
    }
    chunks.push(value)
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length))
}

export function createAramexProvider(config: AramexConfig, fetchResponse = fetch): TrackingProvider {
  return {
    async track(awbs, signal) {
      const numbers = z.array(trackingNumberSchema).min(1).max(20).parse(awbs)
      const response = await fetchResponse(endpoint, {
        method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '"' + aramex + 'Service_1_0/TrackShipments"' },
        body: requestBody(config, numbers),
      })
      return trackingResponse(await readResponse(response), numbers, config)
    },
  }
}
