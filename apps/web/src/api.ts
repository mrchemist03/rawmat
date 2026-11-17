const messages: Record<string, string> = {
  duplicate_tracking_number: "رقم التتبع مسجّل لشحنة أخرى.",
  invalid_credentials: "تحقّق من اسم الدخول وكلمة المرور.",
  invalid_password: "اختر كلمة مرور مختلفة طولها 12 حرفًا على الأقل.",
  invalid_input: "تحقّق من الحقول وأعد المحاولة.",
  duplicate: "الاسم مُستخدم بالفعل. اختر اسمًا آخر.",
  invalid_branch: "اختر شعبة فعّالة.",
  invalid_reference: "تحقّق من الفئة ووحدة القياس والمورد.",
  invalid_name: "أدخل اسمًا يحتوي على حروف أو أرقام.",
  invalid_csv: "تحقّق من ترميز CSV ورؤوس الأعمدة والحد الأقصى للصفوف.",
  export_too_large: "النتائج تتجاوز حد التصدير. ضيّق البحث أو التصفية ثم حاول مرة أخرى.",
  invalid_merge: "اختر مادة فعّالة أخرى لها وحدة القياس نفسها.",
  invalid_purchase_reference: "اختر شعبة فعّالة ومواد فعّالة، وتحقّق من المورد.",
  stale_purchase: "تغيّر الطلب منذ فتحه. أعد فتح تفاصيله قبل المحاولة مجددًا.",
  invalid_transition: "حالة الطلب الحالية لا تسمح بهذا الإجراء.",
  invalid_price_items: "أدخل أسعار بنود هذا الطلب فقط.",
  prices_required: "أدخل سعر الوحدة والعملة لكل بند قبل تأكيد الطلب.",
  invalid_receipt: "تحقّق من الكميات المستلمة. يجب ألا تتجاوز الكمية المتبقية لكل بند.",
  material_unit_in_use: "وحدة القياس مرتبطة بطلب شراء أو بحركة مخزون أو بدمج سابق.",
  invalid_shipment_reference: "اختر شعبتين فعّالتين ومواد متاحة من السجل.",
  insufficient_stock: "رصيد شعبة المصدر لا يكفي لشحن الكمية المطلوبة.",
  stale_shipment: "تغيّرت الشحنة. أعد فتح تفاصيلها قبل المحاولة.",
  invalid_shipment_transition: "الحالة الحالية لا تسمح بهذا التحديث.",
  invalid_shipment_receipt: "أدخل كمية مستلمة لكل بند ضمن الكمية المرسلة.",
  shipment_closed: "تم تأكيد استلام الشحنة سابقًا.",
  tracking_refresh_limited: "انتظر دقيقتين بين طلبات تحديث الشحنة.",
  notification_duplicate: "هذا الرقم مسجّل بالفعل.",
  notification_recipient_limit: "بلغت الحد الأقصى لعدد المستلمين.",
  notification_select_recipient: "اختر مستلمًا فعّالًا لتفعيل التنبيه.",
  notification_unconfigured: "اضبط اتصال n8n على الخادم أولًا.",
  notification_test_limited: "انتظر دقيقتين قبل تكرار الإرسال التجريبي لهذا المستلم.",
  protected_account: "يمكنك تعديل بيانات حسابك الأساسية. غيّر كلمة مرورك من مسار المصادقة.",
  rate_limited: "محاولات كثيرة. انتظر 15 دقيقة قبل المحاولة مجددًا.",
  challenge_required: "أكمل التحقق البشري ثم أعد المحاولة.",
  challenge_unavailable: "خدمة التحقق غير متاحة الآن. حاول مجددًا لاحقًا.",
  try_later: "الخادم مشغول الآن. حاول مجددًا بعد لحظات.",
}

export const unavailable = "تعذّر إتمام الطلب. حاول مجددًا."

export async function request(url: string, body?: unknown, method = "POST", signal?: AbortSignal) {
  return fetch(url, body === undefined ? { cache: "no-store", signal } : {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal,
  })
}

export async function rejection(response: Response) {
  const body: unknown = await response.json().catch(() => null)
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    if (body.error === "rate_limited" && response.headers.get("Retry-After") === "60") {
      return "محاولات كثيرة. انتظر دقيقة قبل المحاولة مجددًا."
    }
    return Object.hasOwn(messages, body.error) ? messages[body.error] ?? unavailable : unavailable
  }
  return unavailable
}
