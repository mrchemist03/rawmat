import { z } from "zod"
import { listQuerySchema } from "./management.js"

export const auditEntityLabels = {
  user: "حساب", branch: "شعبة", material: "مادة", purchase_request: "طلب شراء", shipment: "شحنة",
  categories: "فئة", units: "وحدة", suppliers: "مورد", notification_recipient: "مستلم تنبيهات", notification_rule: "إعداد تنبيه",
}
export const auditQuerySchema = listQuerySchema.extend({
  entity: z.enum(Object.keys(auditEntityLabels) as Array<keyof typeof auditEntityLabels>).optional(),
  from: z.iso.date().optional(), to: z.iso.date().optional(),
}).refine(({ from, to }) => !from || !to || from <= to)

const snapshot = z.record(z.string(), z.union([z.string(), z.boolean(), z.number(), z.null()])).nullable()

export const auditListSchema = z.strictObject({
  items: z.array(z.strictObject({
    id: z.uuid(), actorName: z.string().nullable(), action: z.string(), entity: z.string(),
    entityId: z.string().min(1).max(120), occurredAt: z.number().int(), before: snapshot, after: snapshot,
  })),
  total: z.number().int(),
})

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
  shipment_created: "تسجيل شحنة",
  shipment_tracking_updated: "تحديث تتبع شحنة",
  shipment_tracking_synced: "مزامنة تتبع شحنة",
  notification_recipient_saved: "حفظ مستلم تنبيهات",
  notification_rule_saved: "حفظ إعداد تنبيه",
  shipment_received: "تأكيد استلام شحنة",
  reference_created: "إضافة سجل مرجعي",
  reference_updated: "تعديل سجل مرجعي",
}

export function auditActionLabel(action: string) {
  return Object.hasOwn(actions, action) ? actions[action]! : action
}
