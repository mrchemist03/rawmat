import { shipmentStatus, trackingNumberSchema } from "@rawmat/shared"
import type { ShipmentStatus } from "@rawmat/shared"
import { z } from "zod"

export type TrackingEvent = { status: ShipmentStatus; code: string; description: string; location: string; occurredAt: number }
const carrierEvent = z.strictObject({
  status: shipmentStatus.nullable(), code: z.string().min(1).max(80).regex(/^[A-Za-z0-9_.:-]+$/),
  description: z.string().trim().min(1).max(500), location: z.string().trim().max(120),
  occurredAt: z.number().int().min(0).max(8_640_000_000_000_000),
  raw: z.string().max(8192).optional(),
})
export const trackingResultSchema = z.strictObject({ awb: trackingNumberSchema, events: z.array(carrierEvent).max(100) })
export type TrackingResult = z.infer<typeof trackingResultSchema>

export interface TrackingProvider {
  track(awbs: string[], signal: AbortSignal): Promise<TrackingResult[]>
}

export function trackingFinished(status: ShipmentStatus, receivedAt: number | null) {
  return receivedAt !== null || status === "delivered" || status === "returned"
}

export const supersededTrackingSource = "superseded"

export class ManualProvider implements TrackingProvider {
  async track(awbs: string[]): Promise<TrackingResult[]> {
    return awbs.map((awb) => ({ awb, events: [] }))
  }

  event(status: ShipmentStatus, description: string, location: string, occurredAt: number): TrackingEvent {
    return { status, code: `manual:${status}`, description, location, occurredAt }
  }
}

const progress: ShipmentStatus[] = ["registered", "picked_up", "in_transit", "out_for_delivery", "delivered"]

export function canUpdateTracking(current: ShipmentStatus, next: ShipmentStatus) {
  if (current === "returned" || current === "delivered" || next === "registered") return false
  if (next === "exception" || next === "returned" || current === "exception") return true
  return progress.indexOf(next) >= progress.indexOf(current)
}
