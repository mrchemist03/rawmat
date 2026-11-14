import type { PurchaseStatus } from "@rawmat/shared"

const transitions: Partial<Record<PurchaseStatus, readonly PurchaseStatus[]>> = {
  draft: ["submitted"],
}

export function canTransition(current: PurchaseStatus, next: PurchaseStatus) {
  return transitions[current]?.includes(next) ?? false
}
