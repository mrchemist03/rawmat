import { useEffect, useState } from "react"
import { materialListSchema, pageSize } from "@rawmat/shared"
import type { ReferenceOption } from "@rawmat/shared"
import { useCollection } from "./management"

type OptionSource = { items: ReferenceOption[]; total: number }
export const materialOptions = materialListSchema.transform(({ items, total }) => ({
  items: items.map(({ id, name, unitName, code }) => ({ id, name: `${name} · ${unitName} · ${code}` })), total,
}))

export function Lookup({ label, endpoint, schema, value, select, optional = false }: {
  label: string
  endpoint: string
  schema: { parse(input: unknown): OptionSource }
  value?: ReferenceOption
  select: (value: ReferenceOption | undefined) => void
  optional?: boolean
}) {
  const options = useCollection(endpoint, schema)
  const [term, setTerm] = useState("")
  const search = options.search
  useEffect(() => {
    const timer = window.setTimeout(() => search(term.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [search, term])
  const items = options.result?.items ?? []
  const total = options.result?.total ?? 0
  return <div className="branch-field">
    <label>بحث عن {label}<input type="search" maxLength={120} value={term} onChange={(event) => setTerm(event.target.value)} /></label>
    <label>{label}<select required={!optional} value={value?.id ?? ""} onChange={(event) => {
      const id = event.target.value
      select(items.find((item) => item.id === id) ?? (id === value?.id ? value : undefined))
    }}>
      <option value="">{optional ? "دون مورد" : "اختر من القائمة"}</option>
      {value && !items.some((option) => option.id === value.id) && <option value={value.id}>{value.name}</option>}
      {items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>
    {total > pageSize && <div className="actions">
      <button type="button" className="secondary compact" disabled={options.page <= 1} onClick={() => options.setPage(options.page - 1)}>السابق</button>
      <button type="button" className="secondary compact" disabled={options.page * pageSize >= total}
        onClick={() => options.setPage(options.page + 1)}>التالي</button>
    </div>}
    {options.error && <p role="alert" className="error">{options.error}</p>}
  </div>
}
