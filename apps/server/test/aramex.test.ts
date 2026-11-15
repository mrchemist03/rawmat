import { expect, test, vi } from "vitest"
import { readServerConfig } from "../src/config.js"
import { createAramexProvider, readAramexConfig } from "../src/modules/shipments/aramex.js"

const env = {
  APP_URL: "https://rawmat.example.invalid", TRACKING_PROVIDER: "aramex",
  ARAMEX_USERNAME: "fixture@example.invalid", ARAMEX_PASSWORD: "fixture & <value>",
  ARAMEX_ACCOUNT_NUMBER: "001", ARAMEX_ACCOUNT_PIN: "0000",
  ARAMEX_ACCOUNT_ENTITY: "TEST", ARAMEX_ACCOUNT_COUNTRY_CODE: "TR",
  ARAMEX_EVENT_UTC_OFFSET: "+03:00", ARAMEX_STATUS_MAP: '{"DEMO_DEL":"delivered"}',
}
const signal = new AbortController().signal
const awb = "TEST00001"
const soap = "http://schemas.xmlsoap.org/soap/envelope/"
const contract = "http://ws.aramex.net/ShippingAPI/v1/"
const arrays = "http://schemas.microsoft.com/2003/10/Serialization/Arrays"
const entry = "a:KeyValueOfstringArrayOfTrackingResultmFAkxlpY"

function event(number: string, code: string, description: string, happenedAt = "2026-11-14T12:00:00.000") {
  return "<TrackingResult><WaybillNumber>" + number + "</WaybillNumber><UpdateCode>" + code +
    "</UpdateCode><UpdateDescription>" + description + "</UpdateDescription><UpdateDateTime>" + happenedAt +
    "</UpdateDateTime><UpdateLocation>Fixture</UpdateLocation><Comments>Not exported</Comments></TrackingResult>"
}

function item(number: string, events: string) {
  return "<" + entry + "><a:Key>" + number + "</a:Key><a:Value>" + events + "</a:Value></" + entry + ">"
}

function response(rows: string) {
  return '<s:Envelope xmlns:s="' + soap + '"><s:Body><ShipmentTrackingResponse xmlns="' + contract +
    '" xmlns:a="' + arrays + '"><HasErrors>false</HasErrors><TrackingResults>' + rows +
    "</TrackingResults></ShipmentTrackingResponse></s:Body></s:Envelope>"
}

test("selects only manual or official Aramex tracking and requires a configured account for Aramex", () => {
  expect(readServerConfig({ APP_URL: env.APP_URL }).aramex).toBeUndefined()
  expect(() => readServerConfig({ APP_URL: env.APP_URL, TRACKING_PROVIDER: "aggregator" })).toThrow()
  expect(() => readServerConfig({ ...env, ARAMEX_PASSWORD: "" })).toThrow()
  expect(() => readServerConfig({ ...env, ARAMEX_STATUS_MAP: '{"bad code":"delivered"}' })).toThrow()
  expect(() => readServerConfig({ ...env, ARAMEX_EVENT_UTC_OFFSET: "+14:30" })).toThrow()
  expect(readServerConfig(env)).toMatchObject({ aramex: { utcOffset: "+03:00" }, trackingIntervalMs: 3_600_000 })
})

test("sends the documented SOAP request and normalizes only recognized carrier events", async () => {
  const rows = event(awb, "DEMO_DEL", "Signed", "2026-11-14T15:00:00Z") +
    event(awb, "DEMO_OFD", "Out for delivery") + event(awb, "DEMO_OTHER", "Unrecognized &amp; new")
  const http = vi.fn<typeof fetch>().mockResolvedValue(new Response(response(item(awb, rows) + item("TEST00002", ""))))
  const provider = createAramexProvider(readAramexConfig(env), http)
  const results = await provider.track([awb, "TEST00002"], signal)
  expect(http).toHaveBeenCalledWith("https://ws.aramex.net/ShippingAPI.V2/Tracking/Service_1_0.svc", expect.objectContaining({
    method: "POST", redirect: "error", signal,
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '"' + contract + 'Service_1_0/TrackShipments"' },
    body: expect.stringContaining("<Password>fixture &amp; &lt;value&gt;</Password>"),
  }))
  const body = http.mock.calls[0]?.[1]?.body
  expect(body).toContain("<Shipments><a:string>TEST00001</a:string><a:string>TEST00002</a:string></Shipments>")
  expect(body).toContain("<GetLastTrackingUpdateOnly>false</GetLastTrackingUpdateOnly>")
  expect(body).toContain("<GetUpdateTimeZone>true</GetUpdateTimeZone>")
  expect(results).toEqual([
    { awb, events: [
      expect.objectContaining({ status: "delivered", code: "DEMO_DEL", occurredAt: Date.parse("2026-11-14T15:00:00Z"), description: "Signed", location: "Fixture" }),
      expect.objectContaining({ status: "out_for_delivery", code: "DEMO_OFD", occurredAt: Date.parse("2026-11-14T09:00:00Z"), description: "Out for delivery", location: "Fixture" }),
      expect.objectContaining({ status: null, code: "DEMO_OTHER", occurredAt: Date.parse("2026-11-14T09:00:00Z"), description: "Unrecognized & new", location: "Fixture" }),
    ] }, { awb: "TEST00002", events: [] },
  ])
  expect(JSON.stringify(results)).not.toContain("Not exported")
})

test("rejects faults, excessive or unsafe XML, and unexpected waybills and skips invalid individual results", async () => {
  async function use(body: string, requested = [awb]) {
    const http = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
    return createAramexProvider(readAramexConfig(env), http).track(requested, signal)
  }
  await expect(use('<s:Envelope xmlns:s="' + soap + '"><s:Body><s:Fault /></s:Body></s:Envelope>')).rejects.toThrow(/fault/)
  await expect(use(response("").replace(">false<", ">true<"))).rejects.toThrow()
  await expect(use('<!DOCTYPE ignored []>' + response(""))).rejects.toThrow()
  await expect(use(response(" ".repeat(1_100_000)))).rejects.toThrow(/size limit/)
  await expect(use(response(item("TEST99999", "")))).rejects.toThrow()
  await expect(use(response(item(awb, "") + item(awb, "")))).rejects.toThrow()
  await expect(use(response(item(awb, event("TEST99999", "OK", "Delivered")) + item("TEST00002", "")), [awb, "TEST00002"]))
    .resolves.toEqual([{ awb: "TEST00002", events: [] }])
})
