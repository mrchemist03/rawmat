import { useEffect, useState } from "react"
import type { FormEvent } from "react"
import { currencyDigits, formatMinor, purchaseCostsSchema, purchaseDecisionSchema, purchaseReceiptSchema } from "@rawmat/shared"
import type { PurchaseCosts, PurchaseDetail } from "@rawmat/shared"
import { rejection, request, unavailable } from "./api"

type Operation = "approved" | "rejected" | "ordered" | "cancelled" | "receive"

function toMinor(value: string, currency: string) {
  if (!/^\d+(?:\.\d+)?$/.test(value) || !/^[A-Z]{3}$/.test(currency)) return NaN
  const [whole, fraction = ""] = value.split(".")
  const digits = currencyDigits(currency)
  if (fraction.length > digits) return NaN
  return Number(whole + fraction.padEnd(digits, "0"))
}

const labels: Record<Operation, string> = {
  approved: "اعتماد الطلب", rejected: "رفض الطلب", ordered: "تأكيد الشراء",
  cancelled: "إلغاء الطلب", receive: "تسجيل الاستلام",
}

function PurchasePrices({ item, data }: { item: PurchaseDetail; data: PurchaseCosts }) {
  if (!data.items.length) return null
  return <section>
    <h3>أسعار البنود</h3>
    <ul>{item.items.map((line) => {
      const price = data.items.find(({ itemId }) => itemId === line.id)
      return price && <li key={line.id}>{line.name} · <bdi>{formatMinor(price.unitPriceMinor, price.currency)} {price.currency}</bdi></li>
    })}</ul>
    <ul aria-label="الإجماليات حسب العملة">{data.totals.map(({ currency, totalMinor }) => <li key={currency}>
      الإجمالي <bdi>{formatMinor(totalMinor, currency)} {currency}</bdi>
    </li>)}</ul>
  </section>
}

export function PurchaseOperations({ item, changed }: { item: PurchaseDetail; changed: (message: string) => void }) {
  const [operation, setOperation] = useState<Operation>()
  const [prices, setPrices] = useState<PurchaseCosts>()
  const [priceProblem, setPriceProblem] = useState(false)
  const [includePrices, setIncludePrices] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => {
    if (!item.workflow.viewCosts) return
    let current = true
    request(`/api/purchases/${item.id}/costs`).then(async (response) => {
      if (!response.ok) throw new Error()
      const value = purchaseCostsSchema.parse(await response.json())
      if (current) setPrices(value)
    }).catch(() => { if (current) setPriceProblem(true) })
    return () => { current = false }
  }, [item.id, item.workflow.viewCosts])

  function select(value: Operation) {
    setError("")
    setIncludePrices(value === "ordered" && !prices?.items.length)
    setOperation(value)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!operation || busy) return
    const fields = new FormData(event.currentTarget)
    let payload: unknown
    if (operation === "receive") {
      const items = item.items.map(({ id }) => ({ itemId: id, quantity: String(fields.get(id) ?? "").trim() }))
        .filter(({ quantity }) => quantity && !/^0+(?:\.0+)?$/.test(quantity))
      const result = purchaseReceiptSchema.safeParse({ revision: item.revision, items })
      if (!result.success) return setError("أدخل كمية مستلمة موجبة لبند واحد على الأقل.")
      payload = result.data
    } else {
      const decision: Record<string, unknown> = { status: operation, revision: item.revision }
      if (operation === "rejected" || operation === "cancelled") decision.reason = fields.get("reason")
      if ((operation === "approved" || operation === "ordered") && includePrices) {
        decision.prices = item.items.map(({ id }) => {
          const currency = String(fields.get(`${id}-currency`) ?? "").trim().toUpperCase()
          return { itemId: id, currency, unitPriceMinor: toMinor(String(fields.get(id) ?? "").trim(), currency) }
        })
      }
      const result = purchaseDecisionSchema.safeParse(decision)
      if (!result.success) return setError("تحقّق من السبب أو السعر ورمز العملة وعدد المنازل العشرية.")
      payload = result.data
    }
    setBusy(true)
    setError("")
    try {
      const action = operation === "receive" ? "receipts" : "decision"
      const response = await request(`/api/purchases/${item.id}/${action}`, payload)
      if (!response.ok) return setError(await rejection(response))
      changed(operation === "receive" ? "تم تسجيل الاستلام." : "تم تحديث حالة الطلب.")
    } catch {
      setError(unavailable)
    } finally {
      setBusy(false)
    }
  }

  const needsPrices = operation === "ordered" && !prices?.items.length
  const pricing = operation === "approved" || operation === "ordered"
  return <>
    {prices && <PurchasePrices item={item} data={prices} />}
    {priceProblem && <p role="alert" className="error">تعذّر تحميل أسعار البنود.</p>}
    {!operation && <div className="actions purchase-actions">
      {item.workflow.approve && <button type="button" disabled={!prices} onClick={() => select("approved")}>{labels.approved}</button>}
      {item.workflow.reject && <button type="button" className="secondary" onClick={() => select("rejected")}>{labels.rejected}</button>}
      {item.workflow.order && <button type="button" disabled={!prices} onClick={() => select("ordered")}>{labels.ordered}</button>}
      {item.workflow.receive && <button type="button" onClick={() => select("receive")}>{labels.receive}</button>}
      {item.workflow.cancel && <button type="button" className="secondary" onClick={() => select("cancelled")}>{labels.cancelled}</button>}
    </div>}
    {operation && <form onSubmit={submit} className="purchase-operation">
      <h3>{labels[operation]}</h3>
      {(operation === "cancelled" || operation === "rejected") && <label>السبب<textarea name="reason" required maxLength={500} /></label>}
      {pricing && !needsPrices && <label className="checkbox"><input type="checkbox" checked={includePrices}
        onChange={(event) => setIncludePrices(event.target.checked)} /> إدخال أسعار البنود</label>}
      {pricing && includePrices && item.items.map((line) => {
        const previous = prices?.items.find(({ itemId }) => itemId === line.id)
        return <fieldset key={line.id} className="purchase-items"><legend>{line.name} · {line.unitName}</legend>
          <label>سعر الوحدة<input name={line.id} type="text" dir="ltr" inputMode="decimal" maxLength={20}
            defaultValue={previous && formatMinor(previous.unitPriceMinor, previous.currency)} required /></label>
          <label>رمز العملة<input name={`${line.id}-currency`} dir="ltr" pattern="[A-Za-z]{3}"
            maxLength={3} defaultValue={previous?.currency ?? prices?.defaultCurrency ?? ""} required /></label>
        </fieldset>
      })}
      {operation === "receive" && item.items.filter(({ remainingExact }) => remainingExact !== "0").map((line) =>
        <label key={line.id}>{line.name} · المتبقي <bdi>{line.remainingExact}</bdi> {line.unitName}
          <input name={line.id} type="text" inputMode="decimal" maxLength={338} dir="ltr" />
        </label>)}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions"><button disabled={busy}>حفظ الإجراء</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setOperation(undefined)}>رجوع</button></div>
    </form>}
  </>
}
