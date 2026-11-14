import { auditListSchema } from "@rawmat/shared"
import { Listing, useCollection } from "./management"

const actions: Record<string, string> = {
  superuser_bootstrapped: "إنشاء الحساب الأول",
  password_changed: "تغيير كلمة المرور",
  branch_created: "إضافة شعبة",
  branch_updated: "تعديل شعبة",
  account_created: "إضافة حساب",
  account_updated: "تعديل حساب",
  material_created: "إضافة مادة",
  material_updated: "تعديل مادة",
  material_archived: "أرشفة مادة",
  material_restored: "استعادة مادة",
  material_similarity_confirmed: "تأكيد حفظ مادة مشابهة",
  materials_merged: "دمج مادتين",
  material_import: "استيراد مواد",
  purchase_created: "إنشاء مسودة شراء",
  purchase_updated: "تعديل مسودة شراء",
  purchase_submitted: "إرسال طلب شراء",
  purchase_approved: "اعتماد طلب شراء",
  purchase_rejected: "رفض طلب شراء",
  purchase_ordered: "تأكيد الشراء",
  purchase_cancelled: "إلغاء طلب شراء",
  purchase_receipt: "تسجيل استلام",
  reference_created: "إضافة سجل مرجعي",
  reference_updated: "تعديل سجل مرجعي",
}

const formatTime = new Intl.DateTimeFormat("ar-u-ca-gregory-nu-latn", {
  dateStyle: "medium", timeStyle: "medium", timeZone: "UTC",
})

export function Audit() {
  const data = useCollection("/api/manage/audit", auditListSchema)
  return <section className="surface">
    <h1>سجل التدقيق</h1>
    <Listing data={data}>
      {data.result?.items.length ? <div className="table-scroll"><table>
        <thead><tr><th>التوقيت (UTC)</th><th>الاسم</th><th>الإجراء</th><th>التفاصيل</th></tr></thead>
        <tbody>{data.result.items.map((item) => <tr key={item.id}>
          <td><bdi>{formatTime.format(item.occurredAt)}</bdi></td>
          <td>{item.actorName ?? "النظام"}</td>
          <td>{Object.hasOwn(actions, item.action) ? actions[item.action] : item.action}</td>
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
