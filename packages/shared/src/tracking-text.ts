const translations = new Map<string, string>([
  ["shipment charges paid", "تم سداد رسوم الشحنة"],
  ["delivery scheduled", "تمت جدولة التوصيل"],
  ["sms sent to consignee", "أُرسلت رسالة نصية إلى المستلم"],
  ["received at origin facility", "تم استلام الشحنة في مركز الإرسال"],
  ["shipment information received", "تم استلام بيانات الشحنة"],
  ["shipment created", "تم تسجيل الشحنة"],
  ["picked up", "استلم الناقل الشحنة"],
  ["shipment picked up", "استلم الناقل الشحنة"],
  ["in transit", "الشحنة في الطريق"],
  ["shipment in transit", "الشحنة في الطريق"],
  ["out for delivery", "خرجت الشحنة للتوصيل"],
  ["shipment out for delivery", "خرجت الشحنة للتوصيل"],
  ["delivered", "تم تسليم الشحنة"],
  ["shipment delivered", "تم تسليم الشحنة"],
  ["shipment has been delivered", "تم تسليم الشحنة"],
  ["delivery attempted", "تمت محاولة توصيل الشحنة"],
  ["delivery failed", "تعذّر توصيل الشحنة"],
  ["returned to sender", "أُعيدت الشحنة إلى المرسل"],
  ["shipment returned to sender", "أُعيدت الشحنة إلى المرسل"],
])

export function translateTrackingDescription(description: string) {
  const key = description.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " ").replace(/[.!。]+$/u, "").trim()
  return translations.get(key) ?? description
}
