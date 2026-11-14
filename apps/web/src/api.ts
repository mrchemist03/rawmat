const messages: Record<string, string> = {
  invalid_credentials: "تحقّق من اسم الدخول وكلمة المرور.",
  invalid_password: "اختر كلمة مرور مختلفة طولها 12 حرفًا على الأقل.",
  invalid_input: "تحقّق من الحقول وأعد المحاولة.",
  duplicate: "الاسم مُستخدم بالفعل. اختر اسمًا آخر.",
  invalid_branch: "اختر شعبة فعّالة.",
  invalid_reference: "تحقّق من الفئة ووحدة القياس والمورد.",
  invalid_name: "أدخل اسمًا يحتوي على حروف أو أرقام.",
  invalid_csv: "تحقّق من ترميز CSV ورؤوس الأعمدة والحد الأقصى للصفوف.",
  invalid_merge: "اختر مادة فعّالة أخرى لها وحدة القياس نفسها.",
  invalid_purchase_reference: "اختر شعبة فعّالة ومواد فعّالة، وتحقّق من المورد.",
  stale_purchase: "تغيّر الطلب منذ فتحه. أعد فتح تفاصيله قبل المحاولة مجددًا.",
  invalid_transition: "حالة الطلب الحالية لا تسمح بهذا الإجراء.",
  invalid_price_items: "أدخل أسعار بنود هذا الطلب فقط.",
  prices_required: "أدخل سعر الوحدة والعملة لكل بند قبل تأكيد الطلب.",
  invalid_receipt: "تحقّق من الكميات المستلمة. يجب ألا تتجاوز الكمية المتبقية لكل بند.",
  material_unit_in_use: "وحدة القياس مرتبطة بطلب شراء أو بحركة مخزون أو بدمج سابق.",
  protected_account: "يمكنك تعديل بيانات حسابك الأساسية. غيّر كلمة مرورك من مسار المصادقة.",
  rate_limited: "محاولات كثيرة. انتظر 15 دقيقة قبل المحاولة مجددًا.",
  challenge_required: "أكمل التحقق البشري ثم أعد المحاولة.",
  challenge_unavailable: "خدمة التحقق غير متاحة الآن. حاول مجددًا لاحقًا.",
  try_later: "الخادم مشغول الآن. حاول مجددًا بعد لحظات.",
}

export const unavailable = "تعذّر إتمام الطلب. حاول مجددًا."

export async function request(url: string, body?: unknown, method = "POST") {
  return fetch(url, body === undefined ? { cache: "no-store" } : {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  })
}

export async function rejection(response: Response) {
  const body: unknown = await response.json().catch(() => null)
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return Object.hasOwn(messages, body.error) ? messages[body.error] ?? unavailable : unavailable
  }
  return unavailable
}
