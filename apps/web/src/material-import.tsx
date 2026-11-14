import { useState } from "react"
import { csvHeaders, csvLimit, importReportSchema } from "@rawmat/shared"
import type { z } from "zod"
import { rejection, unavailable } from "./api"

export const matchLabel = { clear: "", exact: "مادة مطابقة", high: "تشابه مرتفع", warning: "تشابه محتمل" }
const reasons: Record<string, string> = {
  invalid_input: "بيانات غير صالحة", invalid_name: "اسم غير صالح", invalid_reference: "فئة أو وحدة أو مورد غير موجود",
}

export function MaterialImport({ canOverride, onClose, onSaved }: {
  canOverride: boolean; onClose: () => void; onSaved: () => void
}) {
  const [file, setFile] = useState<File>()
  const [report, setReport] = useState<z.infer<typeof importReportSchema>>()
  const [confirmed, setConfirmed] = useState(false)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function send(mode: "preview" | "save") {
    if (!file || busy) return
    if (file.size > csvLimit) return setError("الحد الأقصى للملف 5 ميغابايت.")
    setBusy(true)
    setError("")
    try {
      const query = new URLSearchParams({ mode, confirmSimilarity: String(mode === "save" && confirmed) })
      const response = await fetch(`/api/materials/import?${query}`, {
        method: "POST", headers: { "Content-Type": "text/csv" }, body: file, cache: "no-store",
      })
      if (!response.ok) return setError(await rejection(response))
      setReport(importReportSchema.parse(await response.json()))
      if (mode === "save") {
        setSaved(true)
        onSaved()
      }
    } catch {
      setError(unavailable)
    } finally {
      setBusy(false)
    }
  }
  return <section className="editor">
    <h2>استيراد CSV</h2>
    <p>اختر ملفًا بترميز UTF-8. استخدم أسماء الفئات والوحدات والموردين كما تظهر في القوائم المرجعية.</p>
    <p><code dir="ltr">{csvHeaders.join(",")}</code></p>
    <label>ملف CSV<input type="file" accept=".csv,text/csv" disabled={busy} onChange={(event) => {
      setFile(event.target.files?.[0]); setReport(undefined); setSaved(false); setConfirmed(false); setError("")
    }} /></label>
    {error && <p role="alert" className="error">{error}</p>}
    {report && <div className="import-report">
      <p role="status">{saved ? "تم الاستيراد" : "نتيجة المعاينة"} · {report.accepted} مقبول · {report.skipped} مستبعد</p>
      {report.issues.length > 0 && <ul>{report.issues.map(({ row, reason, similarity }) => <li key={row}>
        السجل {row} · {similarity ? matchLabel[similarity.level] : reasons[reason] ?? reason}
        {similarity?.matches[0] && ` · ${similarity.matches[0].name}`}
      </li>)}</ul>}
      {report.skipped > report.issues.length && <p>تظهر أول {report.issues.length} مشكلة.</p>}
    </div>}
    {report && !saved && report.skipped > 0 && <label className="checkbox">
      <input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />
      {canOverride ? "تأكيد إدخال المواد ذات التشابه المحتمل أو المرتفع" : "تأكيد إدخال المواد ذات التشابه المحتمل"}
    </label>}
    <div className="actions">
      {!saved && <button type="button" disabled={!file || busy} onClick={() => void send("preview")}>معاينة</button>}
      {report && !saved && <button type="button" disabled={busy || (!report.accepted && !confirmed)}
        onClick={() => void send("save")}>استيراد الصفوف المقبولة</button>}
      <button type="button" className="secondary" disabled={busy} onClick={onClose}>إغلاق</button>
    </div>
  </section>
}
