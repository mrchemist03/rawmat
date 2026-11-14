import { useEffect, useState } from "react"
import type { FormEvent } from "react"
import {
  materialListSchema, pageSize, purchaseBranchListSchema, purchaseDetailSchema, purchaseIdSchema, purchaseInputSchema,
  purchaseListSchema, purchaseStatus, referenceListSchema,
} from "@rawmat/shared"
import type { PurchaseDetail, PurchaseStatus, ReferenceOption } from "@rawmat/shared"
import { rejection, request, unavailable } from "./api"
import { EditorActions, Listing, useCollection, useEditor } from "./management"

const path = "/api/purchases"
const statusLabels: Record<PurchaseStatus, string> = {
  draft: "مسودة", submitted: "مُرسل", approved: "معتمد", rejected: "مرفوض",
  ordered: "تم الطلب", partially_received: "مُستلم جزئيًا", received: "مُستلم", cancelled: "ملغى",
}
const number = new Intl.NumberFormat("ar-u-nu-latn", { maximumSignificantDigits: 15 })
type OptionSource = { items: ReferenceOption[]; total: number }
type Item = { key: number; material?: ReferenceOption; quantity: string }
const materialOptions = materialListSchema.transform(({ items, total }) => ({
  items: items.map(({ id, name, unitName, code }) => ({ id, name: `${name} · ${unitName} · ${code}` })), total,
}))

function Lookup({ label, endpoint, schema, value, select, optional = false }: {
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

function PurchaseEditor({ initial, onClose, onSaved }: {
  initial?: PurchaseDetail; onClose: () => void; onSaved: (id: string) => void
}) {
  const editor = useEditor(path, initial?.id, async (response) => {
    onSaved(initial?.id ?? purchaseIdSchema.parse(await response.json()).id)
  })
  const [branch, setBranch] = useState(initial && { id: initial.branchId, name: initial.branchName })
  const [supplier, setSupplier] = useState(initial?.supplierId && initial.supplierName
    ? { id: initial.supplierId, name: initial.supplierName } : undefined)
  const [items, setItems] = useState<Item[]>(initial?.items.map((item, key) => ({
    key, material: { id: item.materialId, name: `${item.name} · ${item.unitName} · ${item.code}` }, quantity: String(item.quantity),
  })) ?? [{ key: 0, quantity: "" }])
  const [nextKey, setNextKey] = useState(items.length)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const input = purchaseInputSchema.safeParse({
      branchId: branch?.id, supplierId: supplier?.id ?? null,
      neededOn: form.get("neededOn"), notes: form.get("notes"),
      items: items.map((item) => ({ materialId: item.material?.id, quantity: Number(item.quantity) })),
    })
    if (!input.success) return editor.setError("تحقّق من الحقول واختر مادة مختلفة وكمية موجبة لكل بند.")
    void editor.save(initial ? { ...input.data, revision: initial.revision } : input.data)
  }

  return <section className="editor">
    <h2>{initial ? "تعديل مسودة" : "طلب شراء جديد"}</h2>
    <form onSubmit={submit}>
      <Lookup label="الشعبة الطالبة" endpoint={path + "/branches"} schema={purchaseBranchListSchema} value={branch} select={setBranch} />
      <label>تاريخ الحاجة<input type="date" name="neededOn" defaultValue={initial?.neededOn} required /></label>
      <Lookup label="المورد" endpoint="/api/catalogue/suppliers" schema={referenceListSchema}
        value={supplier} select={setSupplier} optional />
      <label>ملاحظات<textarea name="notes" rows={3} maxLength={2000} defaultValue={initial?.notes} /></label>
      <fieldset className="purchase-items">
        <legend>بنود الطلب</legend>
        {items.map((item, index) => <div className="purchase-item" key={item.key}>
          <Lookup label={`المادة ${index + 1}`} endpoint="/api/materials" schema={materialOptions} value={item.material}
            select={(material) => setItems((current) => current.map((value) => value.key === item.key ? { ...value, material } : value))} />
          <label>الكمية {index + 1}<input type="number" step="any" min="0" max="1000000000" dir="ltr" required
            value={item.quantity} onChange={(event) => {
              const quantity = event.target.value
              setItems((current) => current.map((value) => value.key === item.key ? { ...value, quantity } : value))
            }} /></label>
          {items.length > 1 && <button className="secondary" type="button"
            onClick={() => setItems((current) => current.filter((value) => value.key !== item.key))}>إزالة البند</button>}
        </div>)}
        {items.length < 100 && <button type="button" className="secondary" onClick={() => {
          setItems((current) => [...current, { key: nextKey, quantity: "" }])
          setNextKey(nextKey + 1)
        }}>إضافة بند</button>}
      </fieldset>
      <EditorActions {...editor} onClose={onClose} />
    </form>
  </section>
}

function PurchaseDetails({ item, edit, submitted, onClose }: {
  item: PurchaseDetail; edit: () => void; submitted: () => void; onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [confirm, setConfirm] = useState(false)
  async function send() {
    setBusy(true)
    setError("")
    try {
      const response = await request(`${path}/${item.id}/transition`, { status: "submitted", revision: item.revision })
      if (!response.ok) return setError(await rejection(response))
      submitted()
    } catch {
      setError(unavailable)
    } finally {
      setBusy(false)
    }
  }
  return <section className="editor">
    <h2>تفاصيل الطلب <bdi>{item.number}</bdi></h2>
    <p>{item.branchName} · <bdi>{item.neededOn}</bdi> · {statusLabels[item.status]}</p>
    <p>مقدّم الطلب {item.requesterName}{item.supplierName && ` · المورد ${item.supplierName}`}</p>
    {item.notes && <p className="table-note">{item.notes}</p>}
    <ul>{item.items.map((line) => <li key={line.materialId}>
      {line.name} · <bdi>{number.format(line.quantity)}</bdi> {line.unitName}{line.archived && " (مؤرشفة)"}
    </li>)}</ul>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="actions">
      {item.actions.edit && !confirm && <button type="button" className="secondary" onClick={edit}>تعديل المسودة</button>}
      {item.actions.submit && !confirm && <button type="button" onClick={() => setConfirm(true)}>إرسال للاعتماد</button>}
      {confirm && <button type="button" onClick={() => void send()} disabled={busy}>تأكيد الإرسال</button>}
      {confirm && <button type="button" className="secondary" onClick={() => setConfirm(false)} disabled={busy}>إلغاء الإرسال</button>}
      <button type="button" className="secondary" onClick={onClose} disabled={busy}>إغلاق التفاصيل</button>
    </div>
  </section>
}

export function Purchases() {
  const [status, setStatus] = useState("")
  const [sort, setSort] = useState("newest")
  const filters = new URLSearchParams({ sort })
  if (status) filters.set("status", status)
  const data = useCollection(path, purchaseListSchema, filters.toString())
  const [selected, setSelected] = useState<string>()
  const [detail, setDetail] = useState<PurchaseDetail>()
  const [editing, setEditing] = useState(false)
  const [version, setVersion] = useState(0)
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")
  useEffect(() => {
    if (!selected) return
    let current = true
    request(`${path}/${selected}`).then(async (response) => {
      if (!response.ok) throw new Error()
      const item = purchaseDetailSchema.parse(await response.json())
      if (current) setDetail(item)
    }).catch(() => { if (current) setError(unavailable) })
    return () => { current = false }
  }, [selected, version])

  function refresh(message: string) {
    setEditing(false)
    setDetail(undefined)
    setVersion((value) => value + 1)
    setNotice(message)
    data.setPage(1)
    data.refresh()
  }

  function show(id?: string, edit = false) {
    setSelected(id)
    setDetail(undefined)
    setEditing(edit)
    setNotice("")
    setError("")
    setVersion((value) => value + 1)
  }

  return <section className="surface">
    <div className="section-heading"><h1>طلبات الشراء</h1><button onClick={() => show(undefined, true)}>طلب شراء جديد</button></div>
    {notice && <p className="notice" role="status">{notice}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {editing && <PurchaseEditor key={detail?.id ?? "new"} initial={detail}
      onClose={() => setEditing(false)} onSaved={(id) => {
        setSelected(id)
        setStatus("")
        data.search("")
        refresh("تم حفظ المسودة.")
      }} />}
    {!editing && detail && <PurchaseDetails key={`${detail.id}:${detail.revision}`} item={detail}
      edit={() => setEditing(true)} submitted={() => refresh("أُرسل الطلب للاعتماد.")} onClose={() => show()} />}
    {selected && !editing && !detail && !error && <p role="status">جارٍ تحميل الطلب…</p>}
    <div className="catalogue-filters">
      <label><span id="purchase-status">الحالة</span><select aria-labelledby="purchase-status" value={status}
        onChange={(event) => { data.setPage(1); setStatus(event.target.value) }}>
        <option value="">كل الحالات</option>
        {purchaseStatus.options.map((value) => <option key={value} value={value}>{statusLabels[value]}</option>)}
      </select></label>
      <label><span id="purchase-sort">الفرز</span><select aria-labelledby="purchase-sort" value={sort}
        onChange={(event) => { data.setPage(1); setSort(event.target.value) }}>
        <option value="newest">الأحدث أولًا</option><option value="neededOn">أقرب تاريخ حاجة</option>
      </select></label>
    </div>
    <Listing data={data}>
      {data.result?.items.length ? <div className="table-scroll"><table>
        <thead><tr><th scope="col">الطلب</th><th scope="col">الشعبة</th><th scope="col">المورد</th>
          <th scope="col">تاريخ الحاجة</th><th scope="col">الحالة</th></tr></thead>
        <tbody>{data.result.items.map((item) => <tr key={item.id}>
          <th scope="row"><button className="secondary compact" onClick={() => show(item.id)}><bdi>{item.number}</bdi></button></th>
          <td>{item.branchName}</td><td>{item.supplierName ?? "—"}</td>
          <td><bdi>{item.neededOn}</bdi></td><td>{statusLabels[item.status]}</td>
        </tr>)}</tbody>
      </table></div> : <p className="empty">لا توجد طلبات مطابقة.</p>}
    </Listing>
  </section>
}
