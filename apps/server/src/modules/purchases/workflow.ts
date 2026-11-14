import type { PurchaseStatus } from "@rawmat/shared"

const transitions: Partial<Record<PurchaseStatus, readonly PurchaseStatus[]>> = {
  draft: ["submitted"],
  submitted: ["approved", "rejected", "cancelled"],
  approved: ["ordered", "cancelled"],
  ordered: ["partially_received", "received", "cancelled"],
  partially_received: ["partially_received", "received"],
}

export function canTransition(current: PurchaseStatus, next: PurchaseStatus) {
  return transitions[current]?.includes(next) ?? false
}
