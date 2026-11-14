import type { ShipmentStatus } from "@rawmat/shared"

export type TrackingEvent = { status: ShipmentStatus; code: string; description: string; location: string; occurredAt: number }
export type TrackingResult = { awb: string; events: TrackingEvent[] }

export interface TrackingProvider {
  track(awbs: string[]): Promise<TrackingResult[]>
}

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
