import { useState } from "react"
import type { FormEvent } from "react"
import { auditActionLabel, auditEntityLabels, auditListSchema, auditQuerySchema } from "@rawmat/shared"
import { CsvExport } from "./csv-export"
import { Listing, useCollection } from "./management"

const formatTime = new Intl.DateTimeFormat("ar-u-ca-gregory-nu-latn", {
  dateStyle: "medium", timeStyle: "medium", timeZone: "UTC",
})

export function Audit() {
  const [filters, setFilters] = useState("")
  const [filterError, setFilterError] = useState("")
  const data = useCollection("/api/manage/audit", auditListSchema, filters)
  function filter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const query = new URLSearchParams()
    for (const [key, value] of new FormData(event.currentTarget)) {
      if (typeof value === "string" && value) query.set(key, value)
    }
    if (!auditQuerySchema.safeParse(Object.fromEntries(query)).success) {
      setFilterError("تأكّد من ترتيب تاريخَي البداية والنهاية.")
      return
    }
    setFilterError("")
    data.setPage(1)
    setFilters(query.toString())
  }
  return <section className="surface">
    <div className="section-heading"><h1>سجل التدقيق</h1>
      <CsvExport endpoint="/api/manage/audit/export" filename="audit.csv" query={data.exportQuery} /></div>
    <form className="catalogue-filters" onSubmit={filter}>
      <label>نوع السجل<select name="entity">
        <option value="">جميع الأنواع</option>
        {Object.entries(auditEntityLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select></label>
      <label>من تاريخ (UTC)<input name="from" type="date" /></label>
      <label>إلى تاريخ (UTC)<input name="to" type="date" /></label>
      <button className="secondary" type="submit">تصفية</button>
    </form>
    {filterError && <p role="alert" className="error">{filterError}</p>}
    <Listing data={data}>
      {data.result?.items.length ? <div className="table-scroll"><table>
        <thead><tr><th scope="col">التوقيت (UTC)</th><th scope="col">الاسم</th><th scope="col">الإجراء</th>
          <th scope="col">نوع السجل</th><th scope="col">التفاصيل</th></tr></thead>
        <tbody>{data.result.items.map((item) => <tr key={item.id}>
          <td><bdi>{formatTime.format(item.occurredAt)}</bdi></td>
          <td>{item.actorName ?? "النظام"}</td>
          <td>{auditActionLabel(item.action)}</td>
          <td>{Object.hasOwn(auditEntityLabels, item.entity) ? auditEntityLabels[item.entity as keyof typeof auditEntityLabels] : item.entity}</td>
          <td><details><summary>عرض التفاصيل</summary>
            <p>معرّف السجل <bdi>{item.entityId}</bdi></p>
            {item.before && <><p>قبل</p><pre dir="ltr">{JSON.stringify(item.before, null, 2)}</pre></>}
            {item.after && <><p>بعد</p><pre dir="ltr">{JSON.stringify(item.after, null, 2)}</pre></>}
          </details></td>
        </tr>)}</tbody>
      </table></div> : <p>لا توجد عمليات مطابقة.</p>}
    </Listing>
  </section>
}
