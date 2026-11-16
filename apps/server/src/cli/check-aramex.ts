import { trackingNumberSchema } from "@rawmat/shared"
import { AramexTrackingError, createAramexProvider, readAramexConfig } from "../modules/shipments/aramex.js"

async function readNumber() {
  let input = ""
  process.stdin.setEncoding("utf8")
  for await (const chunk of process.stdin) {
    input += chunk
    if (input.length > 128) return undefined
  }
  const parsed = trackingNumberSchema.safeParse(input)
  return parsed.success ? parsed.data : undefined
}

async function check() {
  if (process.env.TRACKING_PROVIDER !== "aramex") {
    console.error("Enable TRACKING_PROVIDER=aramex in the private server environment.")
    return 1
  }
  if (process.stdin.isTTY) {
    console.error("Pipe one tracking number on standard input without echoing it.")
    return 1
  }
  const number = await readNumber()
  if (!number) {
    console.error("Standard input must contain one valid tracking number.")
    return 1
  }
  let config
  try {
    config = readAramexConfig(process.env)
  } catch {
    console.error("Check the Aramex account fields, environment and protocol settings.")
    return 1
  }
  try {
    const [result] = await createAramexProvider(config).track([number], AbortSignal.timeout(10_000))
    if (!result?.events.length) {
      console.error("No tracking events returned. Check the shipment and account in the selected Aramex environment.")
      return 1
    }
    const recognized = result.events.filter(({ status }) => status !== null).length
    console.log("Aramex " + config.environment + " via " + config.protocol + ": " +
      result.events.length + " events, " + recognized + " recognized statuses.")
    return 0
  } catch (error) {
    if (!(error instanceof AramexTrackingError)) {
      console.error("Aramex check failed.")
      return 1
    }
    if (error.reason === "http") {
      console.error("Aramex returned HTTP " + error.status + ". Verify the requested environment, outbound public IP and account access.")
    } else if (error.reason === "rejected") {
      console.error("Aramex rejected the request. Verify credentials, tracking access and shipment availability in this environment.")
    } else if (error.reason === "format") {
      console.error("Aramex returned an unexpected response. Verify the protocol and environment.")
    } else {
      console.error("Aramex connection failed. Verify outbound HTTPS, DNS and the IP allowlist.")
    }
    return 1
  }
}

try {
  process.exitCode = await check()
} catch {
  console.error("Aramex check failed.")
  process.exitCode = 1
}
