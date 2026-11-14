import type { AccountType, NavigationItem } from "@rawmat/shared"

type Capability = "viewWorkspace" | "createOperations" | "viewCosts" | "approvePurchases" |
  "manageNotifications" | "overrideSimilarity" | "manageAccounts" | "manageBranches" |
  "manageReferenceData" | "manageRecords" | "viewAudit" | "manageSettings"

const common: Capability[] = ["viewWorkspace", "createOperations"]
const administrative: Capability[] = [...common, "viewCosts", "approvePurchases", "manageNotifications", "overrideSimilarity"]
const grants: Record<AccountType, ReadonlySet<Capability>> = {
  user: new Set(common),
  admin: new Set(administrative),
  superuser: new Set([
    ...administrative, "manageAccounts", "manageBranches", "manageReferenceData",
    "manageRecords", "viewAudit", "manageSettings",
  ]),
}

export function can(role: AccountType, capability: Capability) {
  return grants[role]?.has(capability) ?? false
}

export function navigationFor(role: AccountType): NavigationItem[] {
  const result: NavigationItem[] = ["account"]
  if (can(role, "viewWorkspace")) result.push("materials", "purchases")
  if (can(role, "manageAccounts")) result.push("accounts")
  if (can(role, "manageBranches")) result.push("branches")
  if (can(role, "manageReferenceData")) result.push("references")
  if (can(role, "viewAudit")) result.push("audit")
  return result
}
