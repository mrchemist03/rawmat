import { useEffect, useState } from "react"
import type { FormEvent } from "react"
import {
  aramexTrackingUrl, purchaseBranchListSchema, shipmentDetailSchema, shipmentIdSchema, shipmentInputSchema,
  shipmentListSchema, shipmentReceiptSchema, shipmentStatus, shipmentStatusLabels as labels, shipmentUpdateSchema,
  trackingNumberSchema,
} from "@rawmat/shared"
import type { ReferenceOption, ShipmentDetail } from "@rawmat/shared"
import { rejection, request, unavailable } from "./api"
import { Lookup, materialOptions } from "./lookup"
import { EditorActions, Listing, useCollection, useEditor } from "./management"
import { CsvExport } from "./csv-export"

const path = "/api/shipments"
const dateTime = new Intl.DateTimeFormat("ar-u-ca-gregory-nu-latn", {
  dateStyle: "medium", timeStyle: "short",
})
const trackingNotes = {
  pending: "بانتظار نتيجة التحديث الآلي.",
  retrying: "تعذّر جلب الحالة. ستُعاد المحاولة تلقائيًا.",
  stalled: "توقف التحديث الآلي لعدم ورود حدث جديد خلال 30 يومًا.",
  idle: "",
  finished: "",
}
type Item = { key: number; kind: "material" | "description"; material?: ReferenceOption; description: string; quantity: string }

function emptyItem(key: number): Item {
  return { key, kind: "material", description: "", quantity: "" }
}

function ShipmentEditor({ initial, onClose, onSaved }: {
  initial?: ShipmentDetail; onClose: () => void; onSaved: (id: string, duplicate: boolean) => void
}) {
  const editor = useEditor(path, initial?.id, async (response) => {
    if (initial) return onSaved(initial.id, false)
    onSaved(shipmentIdSchema.parse(await response.json()).id, response.status === 200)
  })
  const editData = initial?.edit
  const [source, setSource] = useState<ReferenceOption | undefined>(initial && editData
    ? { id: editData.sourceId, name: initial.sourceName } : undefined)
  const [destination, setDestination] = useState<ReferenceOption | undefined>(initial && editData
    ? { id: editData.destinationId, name: initial.destinationName } : undefined)
  const [items, setItems] = useState<Item[]>(() => initial && editData ? initial.items.map((item, key) => {
    const materialId = editData.materialIds[key]
    return { key, quantity: item.quantity, ...(materialId
      ? { kind: "material", material: { id: materialId, name: item.name }, description: "" }
      : { kind: "description", description: item.name }) }
  }) : [emptyItem(0)])
  const [nextKey, setNextKey] = useState(initial?.items.length ?? 1)
  const [trackingNumber, setTrackingNumber] = useState(initial?.trackingNumber ?? "")
  const [opening, setOpening] = useState(false)

  async function openExisting() {
    const parsed = trackingNumberSchema.safeParse(trackingNumber)
    if (!parsed.success) return editor.setError("أدخل رقم تتبع صالحًا.")
    setOpening(true)
    editor.setError("")
    try {
      const response = await request(`${path}/tracking/${encodeURIComponent(parsed.data)}`)
      if (response.status === 404) return editor.setError("لا توجد شحنة بهذا الرقم. أكمل البيانات لتسجيلها.")
      if (!response.ok) throw new Error()
      onSaved(shipmentIdSchema.parse(await response.json()).id, true)
    } catch {
      editor.setError(unavailable)
    } finally {
      setOpening(false)
    }
  }

  function edit(key: number, changes: Partial<Item>) {
    setItems((current) => current.map((item) => item.key === key ? { ...item, ...changes } : item))
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (opening || editor.busy) return
    const fields = new FormData(event.currentTarget)
    const parsed = shipmentInputSchema.safeParse({
      trackingNumber: fields.get("trackingNumber"), sourceId: source?.id,
      destinationId: destination?.id, dispatchedOn: fields.get("dispatchedOn"),
      items: items.map(({ kind, material, description, quantity }) => ({
        kind, quantity: Number(quantity), ...(kind === "material" ? { materialId: material?.id } : { description }),
      })),
    })
    if (!parsed.success) return editor.setError("تحقّق من رقم التتبع والشعبتين والكميات، واختر كل مادة مرة واحدة.")
    void editor.save(initial ? { ...parsed.data, revision: initial.revision } : parsed.data)
  }

  return <section className="editor">
    <h2>{initial ? "تعديل بيانات الشحنة" : "إضافة شحنة أراميكس"}</h2>
    <form onSubmit={submit}>
      <label>رقم التتبع<input name="trackingNumber" dir="ltr" autoComplete="off" minLength={5} maxLength={32}
        value={trackingNumber} onChange={(event) => setTrackingNumber(event.target.value)} disabled={opening}
        pattern="[A-Za-z0-9]{5,32}" required /></label>
      {!initial && <div className="actions"><button type="button" className="secondary" disabled={opening || editor.busy}
        onClick={() => void openExisting()}>فتح شحنة مسجّلة</button></div>}
      {initial && trackingNumber.trim().toUpperCase() !== initial.trackingNumber &&
        <p role="status">سيبدأ التتبع من جديد للرقم المصحّح.</p>}
      <Lookup label="شعبة المصدر" endpoint={path + "/branches"} schema={purchaseBranchListSchema} value={source} select={setSource} />
      <Lookup label="شعبة الوجهة" endpoint={path + "/branches"} schema={purchaseBranchListSchema}
        value={destination} select={setDestination} />
      <label>تاريخ الإرسال<input name="dispatchedOn" type="date" defaultValue={initial?.dispatchedOn} required /></label>
      <fieldset className="purchase-items">
        <legend>محتويات الشحنة</legend>
        {items.map((item, index) => <div key={item.key} className="purchase-item">
          <label>نوع البند {index + 1}<select value={item.kind} onChange={(event) => {
            edit(item.key, { kind: event.target.value === "description" ? "description" : "material" })
          }}><option value="material">مادة من السجل</option><option value="description">وصف حر</option></select></label>
          {item.kind === "material"
            ? <Lookup label={`المادة ${index + 1}`} endpoint="/api/materials" schema={materialOptions} value={item.material}
              select={(material) => edit(item.key, { material })} />
            : <label>الوصف {index + 1}<input value={item.description} maxLength={250} required
              onChange={(event) => edit(item.key, { description: event.target.value })} /></label>}
          <label>الكمية {index + 1}<input type="number" step="any" min="0" max="1000000000" dir="ltr" required
            value={item.quantity} onChange={(event) => edit(item.key, { quantity: event.target.value })} /></label>
          {items.length > 1 && <button type="button" className="secondary"
            onClick={() => setItems((current) => current.filter(({ key }) => key !== item.key))}>إزالة البند</button>}
        </div>)}
        {items.length < 100 && <button type="button" className="secondary" onClick={() => {
          setItems((current) => [...current, emptyItem(nextKey)])
          setNextKey(nextKey + 1)
        }}>إضافة بند</button>}
      </fieldset>
      <EditorActions {...editor} busy={editor.busy || opening} onClose={onClose} />
    </form>
  </section>
}

function ShipmentAction({ item, action, onClose, onSaved }: {
  item: ShipmentDetail; action: "tracking" | "receipt"; onClose: () => void; onSaved: () => void
}) {
  const editor = useEditor(`${path}/${item.id}/${action}`, undefined, onSaved)
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    const result = action === "tracking" ? shipmentUpdateSchema.safeParse({
      revision: item.revision, status: fields.get("status"), location: fields.get("location"), description: fields.get("description"),
    }) : shipmentReceiptSchema.safeParse({
      revision: item.revision, items: item.items.map(({ id }) => ({ itemId: id, quantity: fields.get(id) })),
    })
    if (!result.success) return editor.setError("تحقّق من الحقول المدخلة وأعد المحاولة.")
    void editor.save(result.data)
  }

  return <form className="purchase-operation" onSubmit={submit}>
    {action === "tracking" ? <>
      <h3>تحديث يدوي للحالة</h3>
      <label>حالة الشحنة<select name="status" defaultValue={item.status === "registered" ? "in_transit" : item.status}>
        {shipmentStatus.options.filter((value) => value !== "registered").map((value) =>
          <option key={value} value={value}>{labels[value]}</option>)}
      </select></label>
      <label>الموقع<input name="location" maxLength={120} defaultValue={item.lastEvent.location} /></label>
      <label><span id="shipment-description-label">وصف الحالة</span>
        <textarea name="description" aria-labelledby="shipment-description-label" maxLength={500} required defaultValue={item.lastEvent.description} />
      </label>
    </> : <>
      <h3>{item.status === "returned" ? "تأكيد الاستلام في المصدر" : "تأكيد الاستلام في الوجهة"}</h3>
      <p>أدخل الكمية التي وصلت لكل بند. سجّل 0 للبند الذي لم يصل. يغلق التأكيد الشحنة.</p>
      {item.items.map((line) => <label key={line.id}>الكمية المستلمة · {line.name}{line.unitName && ` · ${line.unitName}`}
        <input name={line.id} dir="ltr" inputMode="decimal" defaultValue={line.quantity} maxLength={338} required />
      </label>)}
    </>}
    <EditorActions {...editor} onClose={onClose} />
  </form>
}

function ShipmentDetails({ item, onClose, onEdit, changed }: {
  item: ShipmentDetail; onClose: () => void; onEdit: () => void; changed: (message: string) => void
}) {
  const [action, setAction] = useState<"tracking" | "receipt">()
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState("")
  const carrier = aramexTrackingUrl(item.trackingNumber)
  async function refreshTracking() {
    setRefreshing(true)
    setRefreshError("")
    try {
      const response = await request(`${path}/${item.id}/refresh`, {})
      if (!response.ok) return setRefreshError(await rejection(response))
      changed("تم طلب تحديث التتبع.")
    } catch {
      setRefreshError(unavailable)
    } finally {
      setRefreshing(false)
    }
  }
  return <section className="editor">
    <h2>الشحنة <bdi>{item.trackingNumber}</bdi></h2>
    <p>{item.sourceName} ← {item.destinationName} · {labels[item.status]} · <bdi>{item.dispatchedOn}</bdi></p>
    <p><strong>وصف الحالة:</strong> {item.lastEvent.description}</p>
    <p><strong>الموقع:</strong> {item.lastEvent.location || "لم يحدده الناقل"}</p>
    <p>وقت آخر حدث · <bdi>{dateTime.format(item.lastEvent.occurredAt)}</bdi></p>
    {item.receivedAt !== null && <p role="status">الاستلام مؤكّد · <bdi>{dateTime.format(item.receivedAt)}</bdi></p>}
    {item.tracking?.lastPolledAt != null && <p>آخر تحديث ناجح · <bdi>{dateTime.format(item.tracking.lastPolledAt)}</bdi></p>}
    {item.tracking && trackingNotes[item.tracking.state] && <p role="status">{trackingNotes[item.tracking.state]}</p>}
    {refreshError && <p role="alert" className="error">{refreshError}</p>}
    <p><a href={carrier} target="_blank" rel="noopener noreferrer">عرض التتبع في أراميكس</a></p>
    <h3>المحتويات</h3>
    <ul>{item.items.map((line) => <li key={line.id}>
      {line.name} · <bdi>{line.quantity}</bdi> {line.unitName}
      {line.receivedQuantity !== null && <> · المستلم <bdi>{line.receivedQuantity}</bdi></>}
    </li>)}</ul>
    {action && <ShipmentAction item={item} action={action} onClose={() => setAction(undefined)}
      onSaved={() => changed(action === "tracking" ? "تم تحديث حالة الشحنة." : "تم تأكيد استلام الشحنة.")} />}
    {!action && <div className="actions purchase-actions">
      {item.edit && <button type="button" onClick={onEdit}>تعديل الشحنة</button>}
      {item.actions.update && <button type="button" onClick={() => setAction("tracking")}>تحديث يدوي</button>}
      {item.actions.refresh && <button type="button" className="secondary" disabled={refreshing || item.tracking?.state === "pending"}
        onClick={() => void refreshTracking()}>تحديث الآن</button>}
      {item.actions.receive && <button type="button" onClick={() => setAction("receipt")}>{item.status === "returned" ? "استلام المرتجع" : "تأكيد الاستلام"}</button>}
      <button type="button" className="secondary" onClick={onClose}>إغلاق التفاصيل</button>
    </div>}
    <details open><summary>سجل التتبع</summary>
      <ol>{item.events.map((event) => <li key={event.id}>
        <strong>{labels[event.status]}</strong> · <bdi>{dateTime.format(event.occurredAt)}</bdi>
        {event.location && ` · ${event.location}`}<p className="table-note">{event.description}</p>
      </li>)}</ol>
    </details>
  </section>
}

export function Shipments() {
  const [status, setStatus] = useState("")
  const [sort, setSort] = useState("newest")
  const filters = new URLSearchParams({ sort })
  if (status) filters.set("status", status)
  const list = useCollection(path, shipmentListSchema, filters.toString())
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<ShipmentDetail>()
  const [selected, setSelected] = useState<string>()
  const [detail, setDetail] = useState<ShipmentDetail>()
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!selected || editing) return
    let current = true
    let retry: ReturnType<typeof setTimeout> | undefined
    async function load(attempt = 0) {
      try {
        const response = await request(`${path}/${selected}`)
        if (!response.ok) throw new Error()
        const shipment = shipmentDetailSchema.parse(await response.json())
        if (!current) return
        setDetail(shipment)
        setError("")
        if (shipment.tracking?.state === "pending" && attempt < 12) retry = setTimeout(() => void load(attempt + 1), 3000)
        else if (attempt) list.refresh()
      } catch {
        if (current) setError(unavailable)
      }
    }
    void load()
    return () => { current = false; clearTimeout(retry) }
  }, [selected, version, editing])

  function show(id?: string) {
    setCreating(false)
    setEditing(undefined)
    setSelected(id)
    setDetail(undefined)
    setError("")
    setNotice("")
    setVersion((current) => current + 1)
  }

  function changed(message: string) {
    setEditing(undefined)
    setDetail(undefined)
    setError("")
    setNotice(message)
    setVersion((current) => current + 1)
    list.refresh()
  }

  return <section className="surface">
    <div className="section-heading"><h1>الشحنات</h1><div className="actions">
      <CsvExport endpoint={path + "/export"} filename="shipments.csv" query={list.exportQuery} />
      <button onClick={() => { show(); setCreating(true) }}>إضافة شحنة</button>
    </div></div>
    {notice && <p role="status" className="notice">{notice}</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {creating && <ShipmentEditor onClose={() => setCreating(false)} onSaved={(id, duplicate) => {
      show(id)
      setNotice(duplicate ? "رقم التتبع مسجّل سابقًا. فُتحت الشحنة الموجودة." : "تم تسجيل الشحنة.")
      list.setPage(1)
      list.refresh()
    }} />}
    {editing && <ShipmentEditor initial={editing} onClose={() => setEditing(undefined)}
      onSaved={() => changed("تم حفظ تعديل الشحنة.")} />}
    {detail && !editing && <ShipmentDetails key={`${detail.id}:${detail.revision}`} item={detail}
      onClose={() => show()} onEdit={() => setEditing(detail)} changed={changed} />}
    {selected && !detail && !error && <p role="status">جارٍ تحميل الشحنة…</p>}
    <div className="catalogue-filters">
      <label><span id="shipment-status-filter">الحالة</span><select aria-labelledby="shipment-status-filter" value={status}
        onChange={(event) => { list.setPage(1); setStatus(event.target.value) }}>
        <option value="">كل الحالات</option>
        {shipmentStatus.options.map((value) => <option key={value} value={value}>{labels[value]}</option>)}
      </select></label>
      <label><span id="shipment-sort-filter">الفرز</span><select aria-labelledby="shipment-sort-filter" value={sort}
        onChange={(event) => { list.setPage(1); setSort(event.target.value) }}>
        <option value="newest">الأحدث تسجيلًا</option><option value="dispatch">الأحدث إرسالًا</option>
      </select></label>
    </div>
    <Listing data={list}>
      {list.result?.items.length ? <div className="table-scroll"><table>
        <thead><tr><th scope="col">رقم التتبع</th><th scope="col">المصدر</th><th scope="col">الوجهة</th>
          <th scope="col">تاريخ الإرسال</th><th scope="col">الحالة</th><th scope="col">آخر حدث</th></tr></thead>
        <tbody>{list.result.items.map((item) => <tr key={item.id}>
          <th scope="row"><button className="secondary compact" onClick={() => show(item.id)}><bdi>{item.trackingNumber}</bdi></button></th>
          <td>{item.sourceName}</td><td>{item.destinationName}</td><td><bdi>{item.dispatchedOn}</bdi></td>
          <td><span className="shipment-status">{labels[item.status]}</span>{item.receivedAt !== null && <small className="table-note">الاستلام مؤكّد</small>}</td>
          <td>{item.lastEvent.description}<small className="table-note">{item.lastEvent.location}{item.lastEvent.location && " · "}
            <bdi>{dateTime.format(item.lastEvent.occurredAt)}</bdi></small></td>
        </tr>)}</tbody>
      </table></div> : <p className="empty">لا توجد شحنات مطابقة.</p>}
    </Listing>
  </section>
}
