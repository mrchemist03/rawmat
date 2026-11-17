import { useEffect, useState } from "react"
import { auditActionLabel, formatMinor, overviewSchema, purchaseStatus, purchaseStatusLabels } from "@rawmat/shared"
import type { Overview as OverviewData } from "@rawmat/shared"
import { request, unavailable } from "./api"
import { CsvExport } from "./csv-export"

const number = new Intl.NumberFormat("ar-u-nu-latn", { maximumFractionDigits: 2 })
const dateTime = new Intl.DateTimeFormat("ar-u-ca-gregory-nu-latn", {
  dateStyle: "short", timeStyle: "short", timeZone: "UTC",
})

export function Overview() {
  const [data, setData] = useState<OverviewData>()
  const [error, setError] = useState("")
  useEffect(() => {
    const controller = new AbortController()
    request("/api/overview", undefined, "GET", controller.signal).then(async (response) => {
      if (!response.ok) throw new Error()
      const result = overviewSchema.parse(await response.json())
      if (!controller.signal.aborted) setData(result)
    }).catch(() => { if (!controller.signal.aborted) setError(unavailable) })
    return () => controller.abort()
  }, [])

  return <>
    <section className="surface">
      <div className="section-heading"><h1>النظرة العامة</h1>
        {data && <CsvExport endpoint="/api/overview/export" filename="overview.csv" />}</div>
      {error && <p role="alert" className="error">{error}</p>}
      {!data && !error && <p role="status">جارٍ تحميل المؤشرات…</p>}
      {data && <dl className="overview-metrics">
        <div><dt><a href="/purchases">طلبات تنتظر الاعتماد</a></dt><dd>{number.format(data.purchases.statuses.submitted)}</dd></div>
        <div><dt><a href="/purchases">طلبات تجاوزت تاريخ الحاجة</a></dt><dd>{number.format(data.purchases.overdue)}</dd></div>
        <div><dt><a href="/materials">مواد تحت الحد الأدنى</a></dt><dd>{number.format(data.lowStock)}</dd></div>
        <div><dt><a href="/shipments">شحنات في الطريق</a></dt><dd>{number.format(data.shipments.inTransit)}</dd></div>
        <div><dt><a href="/shipments">شحنات بلا تحديث منذ 3 أيام</a></dt><dd>{number.format(data.shipments.overdue)}</dd></div>
        <div><dt>شحنات سُلّمت هذا الشهر</dt><dd>{number.format(data.shipments.deliveredThisMonth)}</dd></div>
      </dl>}
    </section>
    {data && <div className="overview-sections">
      {data.spending && <section className="surface" aria-labelledby="monthly-spending">
        <h2 id="monthly-spending">إنفاق الشهر <bdi>{data.month}</bdi></h2>
        {data.spending.length ? data.spending.map((entry) => <div className="overview-spending" key={entry.currency}>
          <h3><bdi>{entry.currency}</bdi></h3>
          <p className="overview-amount"><bdi>{formatMinor(entry.totalMinor, entry.currency)}</bdi></p>
          <h4>أعلى المواد إنفاقًا</h4>
          <ol>{entry.materials.map((item) => <li key={item.id}>{item.name} · <bdi>{formatMinor(item.amountMinor, entry.currency)}</bdi></li>)}</ol>
        </div>) : <p className="empty">لا توجد مشتريات مؤكدة هذا الشهر.</p>}
      </section>}
      <section className="surface">
        <h2>طلبات الشراء حسب الحالة</h2>
        <dl className="overview-statuses">{purchaseStatus.options.map((status) => <div key={status}>
          <dt>{purchaseStatusLabels[status]}</dt><dd>{number.format(data.purchases.statuses[status])}</dd>
        </div>)}</dl>
      </section>
      <section className="surface">
        <h2>متوسط مدة الشحن</h2>
        {data.shipments.routes.length ? <div className="table-scroll"><table>
          <thead><tr><th scope="col">المصدر</th><th scope="col">الوجهة</th><th scope="col">الشحنات</th><th scope="col">متوسط الأيام</th></tr></thead>
          <tbody>{data.shipments.routes.map((row) => <tr key={row.sourceId + ":" + row.destinationId}>
            <td>{row.sourceName}</td><td>{row.destinationName}</td><td>{number.format(row.count)}</td><td>{number.format(row.averageDays)}</td>
          </tr>)}</tbody>
        </table></div> : <p className="empty">لا توجد شحنات مسلّمة لحساب المتوسط.</p>}
      </section>
      <section className="surface">
        <h2>آخر العمليات</h2>
        {data.activity.length ? <ul className="overview-activity">{data.activity.map((entry) => <li key={entry.id}>
          <span>{auditActionLabel(entry.action)}</span><time dateTime={new Date(entry.occurredAt).toISOString()}>
            <bdi>{dateTime.format(entry.occurredAt)} UTC</bdi>
          </time>
        </li>)}</ul> : <p className="empty">لا توجد عمليات مسجّلة.</p>}
      </section>
    </div>}
  </>
}
