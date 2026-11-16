import { shipmentStatus, trackingNumberSchema } from "@rawmat/shared"
import type { ShipmentStatus } from "@rawmat/shared"
import { SaxesParser } from "saxes"
import { z } from "zod"
import { trackingResultSchema } from "./tracking.js"
import type { TrackingProvider, TrackingResult } from "./tracking.js"

const hosts = { production: "ws.aramex.net", uat: "ws.uat.aramex.net" } as const
const trackingPath = "/ShippingAPI.V2/Tracking/Service_1_0.svc"
const soap = "http://schemas.xmlsoap.org/soap/envelope/"
const aramex = "http://ws.aramex.net/ShippingAPI/v1/"
const arrays = "http://schemas.microsoft.com/2003/10/Serialization/Arrays"
const schemaInstance = "http://www.w3.org/2001/XMLSchema-instance"
const responseLimit = 1024 * 1024
const codePattern = /^[A-Z0-9_.:-]{1,80}$/
const offsetPattern = /^[+-](?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00)$/
const dateWithOffset = z.iso.datetime({ offset: true })
const localDate = z.iso.datetime({ local: true })
const wcfDate = /^\/Date\((-?\d{1,16})(?:[+-]\d{4})?\)\/$/

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
  environment: keyof typeof hosts
  protocol: "json" | "soap"
  utcOffset?: string
  statusMap: Record<string, ShipmentStatus>
}

const credential = z.string().min(1).max(256).refine((value) =>
  value.trim().length > 0 && !/[\x00-\x1f\x7f]/u.test(value))

export function readAramexConfig(env: NodeJS.ProcessEnv): AramexConfig {
  const environment = env.ARAMEX_ENVIRONMENT || "production"
  if (environment !== "production" && environment !== "uat") throw new Error("Invalid ARAMEX_ENVIRONMENT")
  const protocol = env.ARAMEX_PROTOCOL || (environment === "uat" ? "json" : "soap")
  if (protocol !== "json" && protocol !== "soap") throw new Error("Invalid ARAMEX_PROTOCOL")
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
  return { clientInfo: clientInfo.data, environment, protocol, utcOffset, statusMap }
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

const eventFields = ["WaybillNumber", "UpdateCode", "UpdateDescription", "UpdateLocation", "UpdateDateTime", "UpdateTimeZone"] as const
const aramexEvent = z.object({
  WaybillNumber: z.string(), UpdateCode: z.string(), UpdateDateTime: z.string(),
  UpdateDescription: z.string().nullish(), UpdateLocation: z.string().nullish(), UpdateTimeZone: z.string().nullish(),
})
type AramexEvent = z.infer<typeof aramexEvent>

function trackingEvent(row: AramexEvent, awb: string, config: AramexConfig) {
  const field = (name: typeof eventFields[number]) => row[name]?.trim() ?? ""
  const waybill = trackingNumberSchema.safeParse(field("WaybillNumber"))
  const code = field("UpdateCode").toUpperCase()
  const description = field("UpdateDescription")
  const location = field("UpdateLocation")
  const timestamp = field("UpdateDateTime")
  const reportedOffset = field("UpdateTimeZone").toUpperCase().replace(/^(?:GMT|UTC)/, "")
  const offset = offsetPattern.test(reportedOffset) ? reportedOffset : config.utcOffset
  const qualified = dateWithOffset.safeParse(timestamp).success ? timestamp :
    offset && localDate.safeParse(timestamp).success ? timestamp + offset : ""
  const epoch = wcfDate.exec(timestamp)?.[1]
  const occurredAt = epoch === undefined ? Date.parse(qualified) : Number(epoch)
  if (!waybill.success || waybill.data !== awb || !codePattern.test(code) || !Number.isSafeInteger(occurredAt)) {
    throw new Error("Invalid tracking event")
  }
  const normalized = description.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").replace(/[.!。]+$/u, "").trim()
  const status = Object.hasOwn(config.statusMap, code) ? config.statusMap[code]! : descriptions.get(normalized) ?? null
  return {
    status, code, description: description.slice(0, 500) || code, location: location.slice(0, 120),
    occurredAt,
    raw: JSON.stringify({ code, timestamp, timezone: field("UpdateTimeZone").slice(0, 64) }),
  }
}

type Entry = { Key: unknown; Value?: unknown[] | null }
const jsonResponse = z.object({
  HasErrors: z.boolean().optional(),
  TrackingResults: z.array(z.object({ Key: z.string(), Value: z.array(z.unknown()).nullish() })).max(20).nullish(),
})

export class AramexTrackingError extends Error {
  constructor(readonly reason: "timeout" | "connection" | "http" | "rejected" | "format", readonly status?: number) {
    super("Aramex tracking request failed")
  }
}

function soapEntries(xml: string): Entry[] {
  const root = parseXml(xml)
  if (root?.local !== "Envelope" || root.uri !== soap) throw new Error("Invalid SOAP envelope")
  const body = one(root, soap, "Body")
  if (one(body, soap, "Fault")) throw new AramexTrackingError("rejected")
  const response = one(body, aramex, "ShipmentTrackingResponse")
  const hasErrors = one(response, aramex, "HasErrors")?.text.trim()
  const dictionary = one(response, aramex, "TrackingResults")
  if (hasErrors === "true" || hasErrors === "1") throw new AramexTrackingError("rejected")
  if (!dictionary || dictionary.nil || (hasErrors !== undefined && hasErrors !== "false" && hasErrors !== "0")) {
    throw new AramexTrackingError("format")
  }
  return children(dictionary, arrays, "KeyValueOfstringArrayOfTrackingResultmFAkxlpY").map((item) => {
    const value = one(item, arrays, "Value")
    return {
      Key: one(item, arrays, "Key")?.text,
      Value: !value || value.nil ? null : children(value, aramex, "TrackingResult").map((row) =>
        Object.fromEntries(eventFields.map((name) => [name, one(row, aramex, name)?.text]))),
    }
  })
}

function jsonEntries(text: string): Entry[] {
  const response = jsonResponse.parse(JSON.parse(text))
  if (response.HasErrors) throw new AramexTrackingError("rejected")
  if (!response.TrackingResults) throw new AramexTrackingError("format")
  return response.TrackingResults
}

function normalizeEntries(entries: Entry[], requested: string[], config: AramexConfig) {
  const seen = new Set<string>()
  const results: TrackingResult[] = []
  for (const { Key, Value } of entries) {
    const key = trackingNumberSchema.safeParse(Key)
    if (!key.success || !requested.includes(key.data) || seen.has(key.data)) throw new AramexTrackingError("format")
    const awb = key.data
    seen.add(awb)
    if (!Value) continue
    try {
      const events = Value.map((row) => trackingEvent(aramexEvent.parse(row), awb, config))
        .sort((first, second) => second.occurredAt - first.occurredAt).slice(0, 100)
      results.push(trackingResultSchema.parse({ awb, events }))
    } catch {
      // Other waybills in the same batch can still be saved.
    }
  }
  return results
}

async function readResponse(response: Response) {
  if (!response.ok) {
    await response.body?.cancel()
    throw new AramexTrackingError("http", response.status)
  }
  if (!response.body || Number(response.headers.get("content-length")) > responseLimit) {
    await response.body?.cancel()
    throw new AramexTrackingError("format")
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
      throw new AramexTrackingError("format")
    }
    chunks.push(value)
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length))
}

export function createAramexProvider(config: AramexConfig, fetchResponse = fetch): TrackingProvider {
  const json = config.protocol === "json"
  const endpoint = "https://" + hosts[config.environment] + trackingPath + (json ? "/json/TrackShipments" : "")
  return {
    async track(awbs, signal) {
      const numbers = z.array(trackingNumberSchema).min(1).max(20).parse(awbs)
      let text: string
      try {
        const response = await fetchResponse(endpoint, {
          method: "POST", redirect: "manual", signal,
          headers: json ? { "Content-Type": "application/json; charset=utf-8", Accept: "application/json" } :
            { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '"' + aramex + 'Service_1_0/TrackShipments"' },
          body: json ? JSON.stringify({ ClientInfo: config.clientInfo, Shipments: numbers,
            GetLastTrackingUpdateOnly: false, GetUpdateTimeZone: true, LabelInfo: null }) : requestBody(config, numbers),
        })
        text = await readResponse(response)
      } catch (error) {
        if (error instanceof AramexTrackingError) throw error
        throw new AramexTrackingError(signal.aborted ? "timeout" : "connection")
      }
      try {
        return normalizeEntries(json ? jsonEntries(text) : soapEntries(text), numbers, config)
      } catch (error) {
        if (error instanceof AramexTrackingError) throw error
        throw new AramexTrackingError("format")
      }
    },
  }
}
