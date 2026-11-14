import { useCallback, useEffect, useState } from "react"
import type { FormEvent, ReactNode } from "react"
import {
  accountListSchema, branchListSchema, createAccountSchema, createBranchSchema,
  pageSize, updateAccountSchema, updateBranchSchema,
} from "@rawmat/shared"
import type { AccountView, BranchView } from "@rawmat/shared"
import { rejection, request, unavailable } from "./api"

type Collection = "accounts" | "branches"
type Result<T> = { items: T[]; total: number }
const invalid = "تحقّق من الحقول وأعد المحاولة."

function useCollection<T>(collection: Collection, schema: { parse(input: unknown): Result<T> }) {
  const [result, setResult] = useState<Result<T>>()
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [version, refresh] = useState(0)
  const [error, setError] = useState("")
  useEffect(() => {
    let current = true
    const query = new URLSearchParams({ search, page: String(page) })
    setResult(undefined)
    setError("")
    request(`/api/manage/${collection}?${query}`).then(async (response) => {
      if (!current) return
      if (response.status === 404) return window.location.replace("/")
      if (!response.ok) throw new Error()
      const value = schema.parse(await response.json())
      if (current) setResult(value)
    }).catch(() => { if (current) setError(unavailable) })
    return () => { current = false }
  }, [collection, schema, search, page, version])
  const updateSearch = useCallback((value: string) => {
    setPage(1)
    setSearch(value)
  }, [])
  return {
    result, error, page, setPage, search: updateSearch,
    refresh() { refresh((value) => value + 1) },
  }
}

function Listing<T>({ data, children }: { data: ReturnType<typeof useCollection<T>>; children: ReactNode }) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    data.search(String(new FormData(event.currentTarget).get("search") ?? "").trim())
  }
  const pages = Math.max(1, Math.ceil((data.result?.total ?? 0) / pageSize))
  return (
    <>
      <form className="search" onSubmit={submit}>
        <label>بحث<input name="search" type="search" maxLength={120} /></label>
        <button className="secondary" type="submit">بحث</button>
      </form>
      {data.error && <p role="alert" className="error">{data.error}</p>}
      {!data.error && !data.result && <p role="status">جارٍ التحميل…</p>}
      {data.result && children}
      {pages > 1 && <div className="pagination" aria-label="صفحات النتائج">
        <button className="secondary" disabled={data.page <= 1} onClick={() => data.setPage(data.page - 1)}>السابق</button>
        <span>{data.page} / {pages}</span>
        <button className="secondary" disabled={data.page >= pages} onClick={() => data.setPage(data.page + 1)}>التالي</button>
      </div>}
    </>
  )
}

function useEditor(collection: Collection, id: string | undefined, onSaved: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function save(payload: unknown) {
    setBusy(true)
    setError("")
    try {
      const path = `/api/manage/${collection}${id ? `/${id}` : ""}`
      const response = await request(path, payload, id ? "PUT" : "POST")
      if (response.ok) return onSaved()
      setError(await rejection(response))
    } catch {
      setError(unavailable)
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, setError, save }
}

function EditorActions({ busy, error, onClose }: { busy: boolean; error: string; onClose: () => void }) {
  return (
    <>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions">
        <button disabled={busy}>{busy ? "جارٍ الحفظ…" : "حفظ"}</button>
        <button className="secondary" type="button" onClick={onClose} disabled={busy}>إلغاء</button>
      </div>
    </>
  )
}

function BranchEditor({ item, onClose, onSaved }: {
  item: BranchView | null; onClose: () => void; onSaved: () => void
}) {
  const editor = useEditor("branches", item?.id, onSaved)
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    const payload = { name: fields.get("name"), city: fields.get("city") }
    const result = item
      ? updateBranchSchema.safeParse({ ...payload, active: fields.has("active") })
      : createBranchSchema.safeParse(payload)
    if (!result.success) return editor.setError(invalid)
    void editor.save(result.data)
  }
  return (
    <section className="editor" aria-labelledby="branch-editor">
      <h2 id="branch-editor">{item ? "تعديل الشعبة" : "إضافة شعبة"}</h2>
      <form onSubmit={submit}>
        <label>اسم الشعبة<input name="name" maxLength={120} defaultValue={item?.name} required /></label>
        <label>المدينة<input name="city" maxLength={120} defaultValue={item?.city} required /></label>
        {item && <label className="checkbox"><input type="checkbox" name="active" defaultChecked={item.active} /> شعبة فعّالة</label>}
        <EditorActions {...editor} onClose={onClose} />
      </form>
    </section>
  )
}

export function Branches() {
  const data = useCollection("branches", branchListSchema)
  const [editing, setEditing] = useState<BranchView | null>()
  const [notice, setNotice] = useState("")
  return (
    <section className="surface">
      <div className="section-heading"><h1>الشعب</h1><button onClick={() => { setNotice(""); setEditing(null) }}>إضافة شعبة</button></div>
      {notice && <p className="notice" role="status">{notice}</p>}
      {editing !== undefined && <BranchEditor key={editing?.id ?? "new"} item={editing}
        onClose={() => setEditing(undefined)} onSaved={() => { setNotice("تم حفظ الشعبة."); setEditing(undefined); data.refresh() }} />}
      <Listing data={data}>
        {data.result?.items.length ? <div className="table-scroll"><table>
          <thead><tr><th scope="col">الشعبة</th><th scope="col">المدينة</th><th scope="col">الحالة</th><th scope="col">الإجراء</th></tr></thead>
          <tbody>{data.result.items.map((item) => <tr key={item.id}>
            <th scope="row">{item.name}</th><td>{item.city}</td><td>{item.active ? "فعّالة" : "معطّلة"}</td>
            <td><button className="secondary compact" aria-label={`تعديل الشعبة ${item.name}`} onClick={() => { setNotice(""); setEditing(item) }}>تعديل</button></td>
          </tr>)}</tbody>
        </table></div> : <p className="empty">لا توجد شعب مطابقة.</p>}
      </Listing>
    </section>
  )
}

function BranchField({ item }: { item: AccountView | null }) {
  const data = useCollection("branches", branchListSchema)
  const [selected, setSelected] = useState(item?.branchId ?? "")
  const [selectedName, setSelectedName] = useState(item?.branchName ?? "")
  const [filter, setFilter] = useState("")
  const searchBranches = data.search
  useEffect(() => {
    const timer = window.setTimeout(() => searchBranches(filter.trim()), 250)
    return () => clearTimeout(timer)
  }, [filter, searchBranches])
  const available = data.result?.items.filter((branch) => branch.active) ?? []
  const pinned = selected && !available.some((branch) => branch.id === selected)
  return (
    <div className="branch-field">
      <label>الشعبة
        <select name="branchId" value={selected} onChange={(event) => {
          setSelected(event.target.value)
          setSelectedName(event.target.selectedOptions[0]?.text ?? "")
        }}>
          <option value="">دون شعبة</option>
          {pinned && <option value={selected}>{selectedName}</option>}
          {available.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
        </select>
      </label>
      <label>البحث عن شعبة
        <input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} maxLength={120} />
      </label>
      {data.error && <p role="alert" className="error">{data.error}</p>}
    </div>
  )
}

function AccountEditor({ item, onClose, onSaved }: {
  item: AccountView | null; onClose: () => void; onSaved: () => void
}) {
  const editor = useEditor("accounts", item?.id, onSaved)
  const own = Boolean(item?.isCurrentAccount)
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    const payload = {
      name: fields.get("name"), loginName: fields.get("loginName"), branchId: fields.get("branchId") || null,
      accountType: fields.get("accountType") || undefined, temporaryPassword: fields.get("temporaryPassword") || undefined,
    }
    const result = item
      ? updateAccountSchema.safeParse({ ...payload, active: own ? item.active : fields.has("active") })
      : createAccountSchema.safeParse(payload)
    if (!result.success) return editor.setError(invalid)
    void editor.save(result.data)
  }
  return (
    <section className="editor" aria-labelledby="account-editor">
      <h2 id="account-editor">{item ? "تعديل الحساب" : "إضافة حساب"}</h2>
      <form onSubmit={submit}>
        <label>الاسم<input name="name" maxLength={120} defaultValue={item?.name} required /></label>
        <label>اسم الدخول<input name="loginName" minLength={3} maxLength={64} dir="auto" autoComplete="off" defaultValue={item?.loginName} required /></label>
        <BranchField item={item} />
        {!own && <>
          <label>{item ? "تغيير الصلاحيات" : "الصلاحيات"}
            <select name="accountType" defaultValue={item ? "" : "user"}>
              {item && <option value="">الإبقاء على الصلاحيات الحالية</option>}
              <option value="user">العمليات الأساسية</option>
              <option value="admin">العمليات والاعتمادات</option>
              <option value="superuser">الإدارة الكاملة</option>
            </select>
          </label>
          <label>{item ? "كلمة مرور مؤقتة جديدة (اختياري)" : "كلمة المرور المؤقتة"}
            <input type="password" name="temporaryPassword" autoComplete="new-password" minLength={12} maxLength={128} required={!item} />
          </label>
          {item && <label className="checkbox"><input type="checkbox" name="active" defaultChecked={item.active} /> حساب فعّال</label>}
        </>}
        <EditorActions {...editor} onClose={onClose} />
      </form>
    </section>
  )
}

export function Accounts() {
  const data = useCollection("accounts", accountListSchema)
  const [editing, setEditing] = useState<AccountView | null>()
  const [notice, setNotice] = useState("")
  return (
    <section className="surface">
      <div className="section-heading"><h1>الحسابات</h1><button onClick={() => { setNotice(""); setEditing(null) }}>إضافة حساب</button></div>
      {notice && <p className="notice" role="status">{notice}</p>}
      {editing !== undefined && <AccountEditor key={editing?.id ?? "new"} item={editing}
        onClose={() => setEditing(undefined)} onSaved={() => { setNotice("تم حفظ الحساب."); setEditing(undefined); data.refresh() }} />}
      <Listing data={data}>
        {data.result?.items.length ? <div className="table-scroll"><table>
          <thead><tr><th scope="col">الاسم</th><th scope="col">اسم الدخول</th><th scope="col">الشعبة</th><th scope="col">الحالة</th><th scope="col">الإجراء</th></tr></thead>
          <tbody>{data.result.items.map((item) => <tr key={item.id}>
            <th scope="row">{item.name}</th><td><bdi>{item.loginName}</bdi></td><td>{item.branchName ?? "—"}</td>
            <td>{item.active ? "فعّال" : "معطّل"}</td>
            <td><button className="secondary compact" aria-label={`تعديل الحساب ${item.name}`} onClick={() => { setNotice(""); setEditing(item) }}>تعديل</button></td>
          </tr>)}</tbody>
        </table></div> : <p className="empty">لا توجد حسابات مطابقة.</p>}
      </Listing>
    </section>
  )
}
