const translations = new Map<string, string>([
  ["shipment charges paid", "تم سداد رسوم الشحنة"],
  ["delivery scheduled", "تمت جدولة التوصيل"],
  ["sms sent to consignee", "أُرسلت رسالة نصية إلى المستلم"],
  ["received at origin facility", "تم استلام الشحنة في مركز الإرسال"],
  ["shipment received at origin facility", "تم استلام الشحنة في مركز الإرسال"],
  ["shipment received at aramex origin sorting facility", "تم استلام الشحنة في مركز فرز أراميكس بجهة الإرسال"],
  ["received at destination facility", "تم استلام الشحنة في مركز الوجهة"],
  ["shipment received at destination facility", "تم استلام الشحنة في مركز الوجهة"],
  ["departed operations facility - in transit", "غادرت الشحنة مركز العمليات وهي في الطريق"],
  ["picked up from shipper", "استلم الناقل الشحنة من المرسل"],
  ["pickup scheduled", "تمت جدولة استلام الشحنة من المرسل"],
  ["pickup completed", "تم استلام الشحنة من المرسل"],
  ["record created", "تم تسجيل الشحنة"],
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
  ["shipment was delivered", "تم تسليم الشحنة"],
  ["shipment delivered successfully", "تم تسليم الشحنة"],
  ["delivered to consignee", "تم تسليم الشحنة إلى المستلم"],
  ["delivery attempted", "تمت محاولة توصيل الشحنة"],
  ["delivery failed", "تعذّر توصيل الشحنة"],
  ["on hold - awaiting correct delivery address", "الشحنة معلّقة بانتظار عنوان توصيل صحيح"],
  ["returned to sender", "أُعيدت الشحنة إلى المرسل"],
  ["shipment returned to sender", "أُعيدت الشحنة إلى المرسل"],
])

export function translateTrackingDescription(description: string) {
  const key = description.normalize("NFKC").trim().toLowerCase().replace(/[‐‑‒–—]/gu, "-")
    .replace(/\s+/gu, " ").replace(/[.!。]+$/u, "").trim()
  return translations.get(key) ?? description
}
