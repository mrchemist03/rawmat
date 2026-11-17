import { useEffect, useState } from "react"
import type { FormEvent } from "react"
import {
  materialInputSchema, materialListSchema, materialSortSchema, materialStatusSchema, materialStockSchema, pageSize, similarityReportSchema,
  referenceInputSchema, referenceListSchema, supplierInputSchema, supplierListSchema,
} from "@rawmat/shared"
import type { LookupKind, MaterialView, ReferenceOption, SimilarityReport, SupplierInput } from "@rawmat/shared"
import { EditorActions, Listing, useCollection, useEditor } from "./management"
import { CsvExport } from "./csv-export"
import { MaterialImport, matchLabel } from "./material-import"

const materialPath = "/api/materials"
const invalid = "تحقّق من الحقول المطلوبة والحد الأدنى."
const referenceNames: Record<LookupKind, string> = {
  categories: "الفئات", units: "وحدات القياس", suppliers: "الموردون",
}
const sortLabels = { name: "الاسم", code: "الرمز", category: "الفئة", minimum: "الحد الأدنى" }
const numberFormat = new Intl.NumberFormat("ar-u-nu-latn", { maximumFractionDigits: 12 })

function ReferenceField({ kind, label, initial, optional = false, onSelect }: {
  kind: LookupKind; label: string; initial?: ReferenceOption; optional?: boolean; onSelect?: (value: string) => void
}) {
  const data = useCollection(`/api/catalogue/${kind}`, referenceListSchema)
  const [selected, setSelected] = useState(initial)
  const [term, setTerm] = useState("")
  const options = data.result?.items ?? []
  const canPage = data.result && data.result.total > pageSize
  return (
    <div className="branch-field">
      <label>{label}
        <select name={kind} required={!optional} value={selected?.id ?? ""} onChange={(event) => {
          onSelect?.(event.target.value)
          setSelected(options.find((option) => option.id === event.target.value) ??
            (event.target.value === selected?.id ? selected : undefined))
        }}>
          <option value="">{optional ? "دون مورد" : "اختر من القائمة"}</option>
          {selected && !options.some((option) => option.id === selected.id) && <option value={selected.id}>{selected.name}</option>}
          {options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
      </label>
      {(term || canPage) && <label>بحث في {referenceNames[kind]}
        <input type="search" value={term} maxLength={120} onChange={(event) => {
          setTerm(event.target.value)
          data.search(event.target.value.trim())
        }} />
      </label>}
      {canPage && <div className="actions">
        <button type="button" className="secondary compact" disabled={data.page === 1} onClick={() => data.setPage(data.page - 1)}>السابق</button>
        <button type="button" className="secondary compact" disabled={data.page * pageSize >= data.result!.total} onClick={() => data.setPage(data.page + 1)}>التالي</button>
      </div>}
      {data.error && <p role="alert" className="error">{data.error}</p>}
      {data.result?.total === 0 && !optional && <p>لا توجد خيارات. يجب إضافة {referenceNames[kind]} أولًا.</p>}
    </div>
  )
}

function materialLink(id: string) {
  return `/materials?id=${encodeURIComponent(id)}`
}

function MaterialStock({ id }: { id: string }) {
  const stock = useCollection(`${materialPath}/${id}/stock`, materialStockSchema)
  const pages = Math.ceil((stock.result?.total ?? 0) / pageSize)
  return <section className="editor">
    <h2>الرصيد حسب الشعبة</h2>
    {stock.error && <p role="alert" className="error">{stock.error}</p>}
    {!stock.result && !stock.error && <p role="status">جارٍ تحميل الرصيد…</p>}
    {stock.result?.items.length === 0 && <p>لا توجد حركات مخزون لهذه المادة.</p>}
    {stock.result?.items.length ? <ul>{stock.result.items.map(({ branchId, branchName, quantity }) =>
      <li key={branchId}>{branchName} · <bdi>{quantity}</bdi></li>)}</ul> : null}
    {pages > 1 && <div className="actions">
      <button className="secondary" disabled={stock.page <= 1} onClick={() => stock.setPage(stock.page - 1)}>السابق</button>
      <button className="secondary" disabled={stock.page >= pages} onClick={() => stock.setPage(stock.page + 1)}>التالي</button>
    </div>}
  </section>
}

function MaterialEditor({ item, canOverride, onClose, onSaved }: {
  item: MaterialView | null; canOverride: boolean; onClose: () => void; onSaved: () => void
}) {
  const [name, setName] = useState(item?.name ?? "")
  const [unitId, setUnitId] = useState(item?.unitId ?? "")
  const [report, setReport] = useState<SimilarityReport>()
  const [confirmed, setConfirmed] = useState(false)
  const editor = useEditor(materialPath, item?.id, onSaved, async (response) => {
    const body = response.status === 409 ? await response.json().catch(() => null) : null
    const result = similarityReportSchema.safeParse(body?.similarity)
    if (!result.success) return false
    setReport(result.data)
    setConfirmed(false)
    return true
  })
  useEffect(() => {
    setReport(undefined)
    setConfirmed(false)
    if (!name.trim() || !unitId || (name === item?.name && unitId === item.unitId)) return
    const abort = new AbortController()
    const timer = window.setTimeout(async () => {
      const query = new URLSearchParams({ name, unitId })
      if (item) query.set("exclude", item.id)
      try {
        const response = await fetch(`${materialPath}/similarity?${query}`, { signal: abort.signal, cache: "no-store" })
        if (response.ok) {
          const result = similarityReportSchema.parse(await response.json())
          if (!abort.signal.aborted) setReport(result)
        }
      } catch {
        // The submit handler still receives the authoritative result.
      }
    }, 300)
    return () => { window.clearTimeout(timer); abort.abort() }
  }, [name, unitId, item])
  const canConfirm = report?.level === "warning" || (report?.level === "high" && canOverride)
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    const minimum = values.get("minimumQuantity")
    const result = materialInputSchema.safeParse({
      name: values.get("name"), categoryId: values.get("categories"), unitId: values.get("units"),
      supplierId: values.get("suppliers") || null, minimumQuantity: minimum ? Number(minimum) : NaN, notes: values.get("notes"),
    })
    if (!result.success) return editor.setError(invalid)
    void editor.save({ ...result.data, confirmSimilarity: canConfirm && confirmed })
  }
  return (
    <section className="editor" aria-labelledby="material-editor">
      <h2 id="material-editor">{item ? "تعديل المادة" : "إضافة مادة"}</h2>
      <form onSubmit={submit}>
        <label>اسم المادة<input name="name" maxLength={200} value={name} onChange={(event) => setName(event.target.value)} required /></label>
        <ReferenceField kind="categories" label="الفئة" initial={item ? { id: item.categoryId, name: item.categoryName } : undefined} />
        <ReferenceField kind="units" label="وحدة القياس" onSelect={setUnitId}
          initial={item ? { id: item.unitId, name: item.unitName } : undefined} />
        <ReferenceField kind="suppliers" label="المورد المفضّل" optional initial={item?.supplierId && item.supplierName
          ? { id: item.supplierId, name: item.supplierName } : undefined} />
        <label>الحد الأدنى<input name="minimumQuantity" type="number" min="0" max="1000000000" step="any"
          defaultValue={item?.minimumQuantity ?? 0} dir="ltr" required /></label>
        <label>ملاحظات<textarea name="notes" rows={3} maxLength={2000} defaultValue={item?.notes} /></label>
        {report && report.level !== "clear" && <div className="import-report" role="status">
          <strong>{matchLabel[report.level]}</strong>
          <ul>{report.matches.map((match) => <li key={match.id}>
            <a href={materialLink(match.id)}>{match.name}</a>{match.archived && " (مؤرشفة)"}
          </li>)}</ul>
          {canConfirm && <label className="checkbox"><input type="checkbox" checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)} /> تأكيد حفظ المادة رغم التشابه</label>}
        </div>}
        <EditorActions {...editor} busy={editor.busy} blocked={
          report?.level === "exact" || (report?.level === "high" && !canOverride) || (canConfirm && !confirmed)
        } onClose={onClose} />
      </form>
    </section>
  )
}

function MergeEditor({ item, onClose, onSaved }: { item: MaterialView; onClose: () => void; onSaved: () => void }) {
  const editor = useEditor(`${materialPath}/${item.id}`, "merge", onSaved)
  const [target, setTarget] = useState("")
  const data = useCollection(materialPath, materialListSchema)
  return <section className="editor">
    <h2>دمج المادة</h2>
    <p>ستُؤرشف «{item.name}» ويُربط رمزها بالمادة التي تختارها. اختر مادة فعّالة لها وحدة القياس نفسها.</p>
    <Listing data={data}>
      <label>المادة التي ستبقى<select value={target} onChange={(event) => setTarget(event.target.value)}>
        <option value="">اختر مادة</option>
        {data.result?.items.filter((value) => value.id !== item.id && value.unitId === item.unitId).map((value) =>
          <option key={value.id} value={value.id}>{value.name} · {value.code}</option>)}
      </select></label>
    </Listing>
    <form onSubmit={(event) => { event.preventDefault(); if (target) void editor.save({ targetId: target }) }}>
      <EditorActions {...editor} blocked={!target} onClose={onClose} />
    </form>
  </section>
}

function MaterialStatusEditor({ item, onClose, onSaved }: { item: MaterialView; onClose: () => void; onSaved: () => void }) {
  const editor = useEditor(`${materialPath}/${item.id}`, "archive", onSaved)
  return (
    <section className="editor" aria-labelledby="material-status">
      <h2 id="material-status">{item.archived ? "استعادة المادة" : "أرشفة المادة"}</h2>
      <form onSubmit={(event) => { event.preventDefault(); void editor.save({ archived: !item.archived }) }}>
        <p>{item.name}</p>
        <EditorActions {...editor} onClose={onClose} />
      </form>
    </section>
  )
}

export function Materials() {
  const [sort, setSort] = useState("name")
  const [direction, setDirection] = useState("asc")
  const [focus] = useState(() => new URLSearchParams(location.search).get("id"))
  const [status, setStatus] = useState(focus ? "all" : "active")
  const query = new URLSearchParams({ sort, direction, status })
  if (focus) query.set("id", focus)
  const data = useCollection(materialPath, materialListSchema, query.toString())
  const [editing, setEditing] = useState<MaterialView | null>()
  const [changingStatus, setChangingStatus] = useState<MaterialView>()
  const [merging, setMerging] = useState<MaterialView>()
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState("")
  const actions = data.result?.actions
  const showActions = actions?.edit || actions?.archive
  function saved(message: string) {
    setEditing(undefined)
    setChangingStatus(undefined)
    setMerging(undefined)
    data.setPage(1)
    data.refresh()
    setNotice(message)
  }
  return (
    <section className="surface">
      <div className="section-heading"><h1>المواد الأولية</h1>
        <CsvExport endpoint={materialPath + "/export"} filename="materials.csv" query={data.exportQuery} />
        {actions?.create && <div className="actions">
          <button onClick={() => { setNotice(""); setChangingStatus(undefined); setMerging(undefined); setImporting(false); setEditing(null) }}>إضافة مادة</button>
          <button className="secondary" onClick={() => { setNotice(""); setChangingStatus(undefined); setMerging(undefined); setEditing(undefined); setImporting(true) }}>استيراد CSV</button>
        </div>}
      </div>
      {focus && <p><a href="/materials">عرض كل المواد</a></p>}
      {focus && data.result?.items.length === 1 && <MaterialStock id={focus} />}
      {notice && <p role="status" className="notice">{notice}</p>}
      {importing && <MaterialImport canOverride={Boolean(actions?.overrideSimilarity)} onClose={() => setImporting(false)} onSaved={data.refresh} />}
      {merging && <MergeEditor key={merging.id} item={merging} onClose={() => setMerging(undefined)} onSaved={() => saved("تم دمج المادة.")} />}
      {editing !== undefined && <MaterialEditor key={editing?.id ?? "new"} item={editing} canOverride={Boolean(actions?.overrideSimilarity)}
        onClose={() => setEditing(undefined)} onSaved={() => saved("تم حفظ المادة.")} />}
      {changingStatus && <MaterialStatusEditor key={changingStatus.id} item={changingStatus}
        onClose={() => setChangingStatus(undefined)} onSaved={() => saved(changingStatus.archived ? "تمت استعادة المادة." : "تمت أرشفة المادة.")} />}
      <div className="catalogue-filters">
        <label><span id="material-status-filter">الحالة</span><select aria-labelledby="material-status-filter"
          value={status} onChange={(event) => { data.setPage(1); setStatus(event.target.value) }}>
          {materialStatusSchema.options.map((value) => <option key={value} value={value}>
            {{ active: "فعّالة", archived: "مؤرشفة", all: "الكل" }[value]}
          </option>)}
        </select></label>
        <label><span id="material-sort-filter">الفرز</span><select aria-labelledby="material-sort-filter"
          value={sort} onChange={(event) => { data.setPage(1); setSort(event.target.value) }}>
          {materialSortSchema.options.map((value) => <option key={value} value={value}>{sortLabels[value]}</option>)}
        </select></label>
        <label><span id="material-direction-filter">الترتيب</span><select aria-labelledby="material-direction-filter"
          value={direction} onChange={(event) => { data.setPage(1); setDirection(event.target.value) }}>
          <option value="asc">تصاعدي</option><option value="desc">تنازلي</option>
        </select></label>
      </div>
      <Listing data={data}>
        {data.result?.items.length ? <div className="table-scroll"><table>
          <thead><tr><th scope="col">المادة</th><th scope="col">الرمز</th><th scope="col">الفئة</th><th scope="col">الوحدة</th>
            <th scope="col">الحد الأدنى</th><th scope="col">المورد المفضّل</th><th scope="col">الحالة</th>
            {showActions && <th scope="col">الإجراءات</th>}
          </tr></thead>
          <tbody>{data.result.items.map((item) => <tr key={item.id}>
            <th scope="row"><a href={materialLink(item.id)}>{item.name}</a>{item.notes && <small className="table-note">{item.notes}</small>}</th>
            <td><bdi className="material-code">{item.code}</bdi></td><td>{item.categoryName}</td><td>{item.unitName}</td>
            <td><bdi>{numberFormat.format(item.minimumQuantity)}</bdi></td><td>{item.supplierName ?? "—"}</td>
            <td>{item.mergedIntoId ? <a href={materialLink(item.mergedIntoId)}>دُمجت</a> : item.archived ? "مؤرشفة" : "فعّالة"}</td>
            {showActions && <td><div className="actions">
              {actions?.edit && !item.archived && <button className="secondary compact" aria-label={`تعديل المادة ${item.name}`}
                onClick={() => { setNotice(""); setChangingStatus(undefined); setMerging(undefined); setImporting(false); setEditing(item) }}>تعديل</button>}
              {actions?.archive && !item.mergedIntoId && <>
                <button className="secondary compact" aria-label={`${item.archived ? "استعادة" : "أرشفة"} المادة ${item.name}`}
                  onClick={() => { setNotice(""); setEditing(undefined); setMerging(undefined); setImporting(false); setChangingStatus(item) }}>{item.archived ? "استعادة" : "أرشفة"}</button>
                <button className="secondary compact" aria-label={`دمج المادة ${item.name}`}
                  onClick={() => { setNotice(""); setEditing(undefined); setChangingStatus(undefined); setImporting(false); setMerging(item) }}>دمج</button>
              </>}
            </div></td>}
          </tr>)}</tbody>
        </table></div> : <p className="empty">لا توجد مواد مطابقة.</p>}
      </Listing>
    </section>
  )
}

type Reference = ReferenceOption & Partial<SupplierInput>

function ReferenceEditor({ kind, item, onClose, onSaved }: {
  kind: LookupKind; item: Reference | null; onClose: () => void; onSaved: () => void
}) {
  const editor = useEditor(`/api/manage/catalogue/${kind}`, item?.id, onSaved)
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = Object.fromEntries(new FormData(event.currentTarget))
    const parsed = (kind === "suppliers" ? supplierInputSchema : referenceInputSchema).safeParse(values)
    if (!parsed.success) return editor.setError("تحقّق من الحقول وأعد المحاولة.")
    void editor.save(parsed.data)
  }
  return <section className="editor" aria-labelledby="reference-editor">
    <h2 id="reference-editor">{item ? "تعديل البيانات" : "إضافة سجل"}</h2>
    <form onSubmit={submit}>
      <label>الاسم<input name="name" maxLength={120} defaultValue={item?.name} required /></label>
      {kind === "suppliers" && <>
        <label>جهة الاتصال<input name="contact" maxLength={250} defaultValue={item?.contact} /></label>
        <label>ملاحظات<textarea name="notes" rows={3} maxLength={2000} defaultValue={item?.notes} /></label>
      </>}
      <EditorActions {...editor} onClose={onClose} />
    </form>
  </section>
}

function ReferenceList({ kind }: { kind: LookupKind }) {
  const data = useCollection<{ items: Reference[]; total: number }>(`/api/manage/catalogue/${kind}`,
    kind === "suppliers" ? supplierListSchema : referenceListSchema)
  const [editing, setEditing] = useState<Reference | null>()
  const [notice, setNotice] = useState("")
  const supplier = kind === "suppliers"
  return <>
    <div className="section-heading"><h2>{referenceNames[kind]}</h2>
      <button onClick={() => { setNotice(""); setEditing(null) }}>إضافة سجل</button></div>
    {notice && <p role="status" className="notice">{notice}</p>}
    {editing !== undefined && <ReferenceEditor key={editing?.id ?? "new"} kind={kind} item={editing}
      onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); data.setPage(1); data.refresh(); setNotice("تم حفظ السجل.") }} />}
    <Listing data={data}>
      {data.result?.items.length ? <div className="table-scroll"><table>
        <thead><tr><th scope="col">الاسم</th>{supplier && <><th scope="col">جهة الاتصال</th><th scope="col">ملاحظات</th></>}
          <th scope="col">الإجراء</th></tr></thead>
        <tbody>{data.result.items.map((item) => <tr key={item.id}>
          <th scope="row">{item.name}</th>
          {supplier && <><td>{item.contact || "—"}</td><td>{item.notes || "—"}</td></>}
          <td><button className="secondary compact" aria-label={`تعديل ${item.name}`}
            onClick={() => { setNotice(""); setEditing(item) }}>تعديل</button></td>
        </tr>)}</tbody>
      </table></div> : <p className="empty">لا توجد سجلات مطابقة.</p>}
    </Listing>
  </>
}

export function References() {
  const [kind, setKind] = useState<LookupKind>("categories")
  return <section className="surface">
    <h1>القوائم المرجعية</h1>
    <div className="catalogue-filters" role="group" aria-label="القائمة المرجعية">
      {(["categories", "units", "suppliers"] as const).map((option) => <button key={option} type="button"
        className={option === kind ? "" : "secondary"} aria-pressed={option === kind}
        onClick={() => setKind(option)}>{referenceNames[option]}</button>)}
    </div>
    <ReferenceList key={kind} kind={kind} />
  </section>
}
