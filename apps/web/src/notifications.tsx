import { useEffect, useState } from "react"
import type { FormEvent } from "react"
import {
  notificationHistorySchema, notificationRecipientInput, notificationRuleInput, notificationsSettingsSchema, pageSize,
} from "@rawmat/shared"
import type { NotificationEvent, NotificationType } from "@rawmat/shared"
import type { z } from "zod"
import { rejection, request, unavailable } from "./api"
import { EditorActions, useCollection, useEditor } from "./management"

const path = "/api/notifications"
const labels: Record<NotificationEvent, string> = {
  "purchase.submitted": "طلب شراء ينتظر الاعتماد", "purchase.decided": "اعتماد أو رفض طلب شراء",
  "purchase.received": "استلام طلب شراء", "purchase.overdue": "تجاوز تاريخ الحاجة",
  "shipment.updated": "تغيّر حالة شحنة", "shipment.delivered": "تسليم شحنة",
  "shipment.attention": "تأخّر شحنة أو وجود مشكلة", "inventory.low": "مادة تحت الحد الأدنى",
  "notification.test": "إرسال تجريبي",
}
const states = { pending: "قيد الإرسال", sent: "استلمه n8n", failed: "فشل" }
const failures = {
  connection: "تعذّر الاتصال", http: "رفض n8n الطلب", response: "تعذّر تأكيد قبول n8n",
  recipients: "تغيّر المستلمون أو عُطّلوا",
}
const formatTime = new Intl.DateTimeFormat("ar-u-ca-gregory-nu-latn", { dateStyle: "medium", timeStyle: "short" })
type Settings = z.infer<typeof notificationsSettingsSchema>
type Recipient = Settings["recipients"][number]
type Rule = Settings["rules"][number]

function RecipientEditor({ item, onClose, onSaved }: { item: Recipient | null; onClose: () => void; onSaved: () => void }) {
  const editor = useEditor(path + "/recipients", item?.id, onSaved)
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    const parsed = notificationRecipientInput.safeParse({
      name: fields.get("name"), phone: fields.get("phone"), active: fields.has("active"),
    })
    if (!parsed.success) return editor.setError("أدخل اسم المستلم ورقمه بالصيغة الدولية بدءًا بعلامة +.")
    void editor.save(parsed.data)
  }
  return <section className="editor">
    <h3>{item ? "تعديل المستلم" : "إضافة مستلم"}</h3>
    <form onSubmit={submit}>
      <label>الاسم<input name="name" defaultValue={item?.name} maxLength={120} required /></label>
      <label>الرقم الدولي<input name="phone" type="tel" dir="ltr" defaultValue={item?.phone} maxLength={16} required /></label>
      <label className="checkbox"><input type="checkbox" name="active" defaultChecked={item?.active ?? true} /> مستلم فعّال</label>
      <EditorActions {...editor} onClose={onClose} />
    </form>
  </section>
}

function RuleEditor({ rule, recipients, onClose, onSaved }: {
  rule: Rule; recipients: Recipient[]; onClose: () => void; onSaved: () => void
}) {
  const editor = useEditor(path + "/rules", rule.event, onSaved)
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    const parsed = notificationRuleInput.safeParse({ enabled: fields.has("enabled"), recipientIds: fields.getAll("recipients") })
    if (!parsed.success) return editor.setError("تحقّق من الإعدادات ثم أعِد المحاولة.")
    void editor.save(parsed.data)
  }
  return <section className="editor">
    <h3>{labels[rule.event]}</h3>
    <form onSubmit={submit}>
      <label className="checkbox"><input type="checkbox" name="enabled" defaultChecked={rule.enabled} /> تفعيل التنبيه</label>
      <fieldset>
        <legend>المستلمون</legend>
        {recipients.length ? recipients.map(({ id, name, active }) => <label className="checkbox" key={id}>
          <input type="checkbox" name="recipients" value={id} defaultChecked={rule.recipientIds.includes(id)} />
          {name}{!active && " · معطّل"}
        </label>) : <p>أضف مستلمًا فعّالًا لتفعيل هذا التنبيه.</p>}
      </fieldset>
      <EditorActions {...editor} onClose={onClose} />
    </form>
  </section>
}

export function Notifications() {
  const [settings, setSettings] = useState<Settings>()
  const [version, setVersion] = useState(0)
  const [recipient, setRecipient] = useState<Recipient | null>()
  const [event, setEvent] = useState<NotificationType>()
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")
  const [working, setWorking] = useState(false)
  const history = useCollection(path + "/history", notificationHistorySchema)
  const pages = Math.max(1, Math.ceil((history.result?.total ?? 0) / pageSize))
  const rule = settings?.rules.find((row) => row.event === event)

  useEffect(() => {
    let current = true
    request(path).then(async (response) => {
      if (!response.ok) throw new Error()
      const value = notificationsSettingsSchema.parse(await response.json())
      if (current) setSettings(value)
    }).catch(() => { if (current) setError(unavailable) })
    return () => { current = false }
  }, [version])

  function saved() {
    setRecipient(undefined)
    setEvent(undefined)
    setVersion((value) => value + 1)
    setNotice("تم حفظ الإعدادات.")
  }

  async function queue(route: string) {
    setNotice("")
    setError("")
    setWorking(true)
    try {
      const response = await request(path + route, {})
      if (!response.ok) return setError(await rejection(response))
      history.setPage(1)
      history.refresh()
      setNotice("أُضيف التنبيه إلى طابور الإرسال.")
    } catch {
      setError(unavailable)
    } finally {
      setWorking(false)
    }
  }

  return <section className="surface">
    <h1>التنبيهات</h1>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {!settings && !error && <p role="status">جارٍ التحميل…</p>}
    {settings && <>
      {!settings.configured && <p>الإرسال متوقف إلى حين ضبط اتصال n8n على الخادم.</p>}
      <div className="section-heading"><h2>المستلمون</h2>
        <button onClick={() => { setRecipient(null); setEvent(undefined) }}>إضافة مستلم</button></div>
      {recipient !== undefined && <RecipientEditor key={recipient?.id ?? "new"} item={recipient} onSaved={saved}
        onClose={() => setRecipient(undefined)} />}
      {settings.recipients.length ? <div className="table-scroll"><table>
        <thead><tr><th scope="col">الاسم</th><th scope="col">الرقم الدولي</th><th scope="col">الحالة</th><th scope="col">الإجراءات</th></tr></thead>
        <tbody>{settings.recipients.map((item) => <tr key={item.id}>
          <th scope="row">{item.name}</th><td><bdi>{item.phone}</bdi></td><td>{item.active ? "فعّال" : "معطّل"}</td>
          <td><div className="actions">
            <button className="compact secondary" onClick={() => { setRecipient(item); setEvent(undefined) }}>تعديل</button>
            <button className="compact secondary" disabled={!settings.configured || !item.active || working}
              onClick={() => void queue("/recipients/" + item.id + "/test")}>إرسال تجريبي</button>
          </div></td>
        </tr>)}</tbody>
      </table></div> : <p className="empty">لا يوجد مستلمون.</p>}
      <h2>أنواع التنبيهات</h2>
      {rule && <RuleEditor key={rule.event} rule={rule} recipients={settings.recipients} onSaved={saved} onClose={() => setEvent(undefined)} />}
      <div className="table-scroll"><table>
        <thead><tr><th scope="col">النوع</th><th scope="col">الحالة</th><th scope="col">المستلمون</th><th scope="col">الإجراءات</th></tr></thead>
        <tbody>{settings.rules.map((row) => <tr key={row.event}>
          <th scope="row">{labels[row.event]}</th><td>{row.enabled ? "مفعّل" : "متوقف"}</td>
          <td>{settings.recipients.filter((item) => item.active && row.recipientIds.includes(item.id)).map(({ name }) => name).join("، ") || "—"}</td>
          <td><button className="compact secondary" onClick={() => { setEvent(row.event); setRecipient(undefined) }}>تعديل</button></td>
        </tr>)}</tbody>
      </table></div>
      <div className="section-heading"><h2>سجل الإرسال</h2>
        <button className="secondary" onClick={() => history.refresh()}>تحديث السجل</button></div>
      {history.error && <p className="error" role="alert">{history.error}</p>}
      {history.result?.items.length ? <div className="table-scroll"><table>
        <thead><tr><th scope="col">النوع</th><th scope="col">الوقت</th><th scope="col">الحالة</th><th scope="col">المحاولات</th></tr></thead>
        <tbody>{history.result.items.map((item) => <tr key={item.id}>
          <th scope="row">{labels[item.event]}</th>
          <td><bdi>{formatTime.format(item.sentAt ?? item.occurredAt)}</bdi></td>
          <td>{item.state === "pending" && item.attempts ? "قيد إعادة المحاولة" : states[item.state]}
            {item.lastError && <small className="table-note">{failures[item.lastError]}</small>}
            {item.state === "failed" && item.lastError !== "recipients" && settings.configured &&
              <button className="secondary compact" disabled={working} onClick={() => void queue("/history/" + item.id + "/retry")}>إعادة المحاولة</button>}
          </td><td>{item.attempts}</td>
        </tr>)}</tbody>
      </table></div> : history.result && <p className="empty">لا توجد تنبيهات مسجّلة.</p>}
      {!history.result && !history.error && <p role="status">جارٍ تحميل السجل…</p>}
      {pages > 1 && <div className="pagination" aria-label="صفحات سجل الإرسال">
        <button className="secondary" disabled={history.page <= 1} onClick={() => history.setPage(history.page - 1)}>السابق</button>
        <span>{history.page} / {pages}</span>
        <button className="secondary" disabled={history.page >= pages} onClick={() => history.setPage(history.page + 1)}>التالي</button>
      </div>}
    </>}
  </section>
}
