import { useCallback, useEffect, useState } from "react"
import type { FormEvent, ReactNode } from "react"
import { changePasswordSchema, loginConfigSchema, loginSchema, sessionViewSchema } from "@rawmat/shared"
import type { z } from "zod"
import { Turnstile } from "./turnstile"

type Session = z.infer<typeof sessionViewSchema>
const onLoginPage = window.location.pathname === "/login"

const messages: Record<string, string> = {
  invalid_credentials: "تحقّق من اسم الدخول وكلمة المرور.",
  invalid_password: "اختر كلمة مرور مختلفة طولها 12 حرفًا على الأقل.",
  rate_limited: "محاولات كثيرة. انتظر 15 دقيقة قبل المحاولة مجددًا.",
  challenge_required: "أكمل التحقق البشري ثم أعد المحاولة.",
  challenge_unavailable: "خدمة التحقق غير متاحة الآن. حاول مجددًا لاحقًا.",
  try_later: "الخادم مشغول الآن. حاول مجددًا بعد لحظات.",
}
const unavailable = "تعذّر إتمام الطلب. حاول مجددًا."

async function request(url: string, body?: unknown) {
  return fetch(url, body === undefined ? { cache: "no-store" } : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  })
}

async function rejection(response: Response) {
  const body: unknown = await response.json().catch(() => null)
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return Object.hasOwn(messages, body.error) ? messages[body.error] ?? unavailable : unavailable
  }
  return unavailable
}

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="layout">
      <section className="panel" aria-labelledby="page-title">
        <header><span className="product">إدارة المواد الأولية</span><h1 id="page-title">{title}</h1></header>
        {children}
      </section>
    </main>
  )
}

function Login() {
  const [siteKey, setSiteKey] = useState<string | null>()
  const [token, setToken] = useState<string | null>(null)
  const [widget, setWidget] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [widgetError, setWidgetError] = useState(false)
  const challengeError = useCallback(() => setWidgetError(true), [])
  const receiveToken = useCallback((value: string | null) => {
    setToken(value)
    if (value) setWidgetError(false)
  }, [])

  useEffect(() => {
    request("/api/auth/config").then(async (response) => {
      if (!response.ok) throw new Error()
      setSiteKey(loginConfigSchema.parse(await response.json()).turnstileSiteKey)
    }).catch(() => setError("تعذّر تحميل إعدادات الدخول. أعد تحميل الصفحة."))
  }, [])

  function resetChallenge() {
    setToken(null)
    setWidgetError(false)
    setWidget((current) => current + 1)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || siteKey === undefined || (siteKey && !token)) return
    const fields = new FormData(event.currentTarget)
    const input = loginSchema.safeParse({
      loginName: fields.get("loginName"),
      password: fields.get("password"),
      turnstileToken: token ?? undefined,
    })
    if (!input.success) {
      setError("تحقّق من اسم الدخول وكلمة المرور.")
      return
    }
    setBusy(true)
    setError("")
    try {
      const response = await request("/api/auth/login", input.data)
      if (response.ok) {
        window.location.replace("/")
        return
      }
      setError(await rejection(response))
    } catch {
      setError(unavailable)
    }
    setBusy(false)
    resetChallenge()
  }

  return (
    <Shell title="تسجيل الدخول">
      <form onSubmit={submit}>
        <label>اسم الدخول<input name="loginName" autoComplete="username" maxLength={64} dir="auto" required /></label>
        <label>كلمة المرور<input name="password" type="password" autoComplete="current-password" maxLength={128} dir="auto" required /></label>
        {siteKey && <Turnstile key={widget} siteKey={siteKey} onToken={receiveToken} onError={challengeError} />}
        {widgetError && <button className="secondary" type="button" onClick={resetChallenge}>إعادة تحميل التحقق</button>}
        {error && <p role="alert" className="error">{error}</p>}
        <button disabled={busy || siteKey === undefined || Boolean(siteKey && !token)}>{busy ? "جارٍ تسجيل الدخول…" : "دخول"}</button>
      </form>
    </Shell>
  )
}

function Account() {
  const [session, setSession] = useState<Session>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    request("/api/auth/session").then(async (response) => {
      if (response.status === 401) return window.location.replace("/login")
      if (!response.ok) throw new Error()
      setSession(sessionViewSchema.parse(await response.json()))
    }).catch(() => setError(unavailable))
  }, [])

  async function logout() {
    setBusy(true)
    setError("")
    try {
      const response = await request("/api/auth/logout", {})
      if (!response.ok) throw new Error()
      window.location.replace("/login")
    } catch {
      setError(unavailable)
      setBusy(false)
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const fields = new FormData(form)
    const input = changePasswordSchema.safeParse({
      currentPassword: fields.get("currentPassword"),
      newPassword: fields.get("newPassword"),
    })
    if (!input.success) {
      setError(messages.invalid_password ?? unavailable)
      return
    }
    if (input.data.newPassword !== fields.get("confirmation")) {
      setError("كلمتا المرور غير متطابقتين.")
      return
    }
    setBusy(true)
    setError("")
    try {
      const response = await request("/api/auth/password", input.data)
      if (response.ok) {
        form.reset()
        setSession(sessionViewSchema.parse(await response.json()))
      } else {
        setError(await rejection(response))
      }
    } catch {
      setError(unavailable)
    } finally {
      setBusy(false)
    }
  }

  if (!session) {
    return <Shell title="الحساب"><p role={error ? "alert" : "status"}>{error || "جارٍ التحقق من الجلسة…"}</p></Shell>
  }

  return (
    <Shell title={session.mustChangePassword ? "تغيير كلمة المرور" : "الحساب"}>
      {session.mustChangePassword ? (
        <form onSubmit={changePassword}>
          <p>عيّن كلمة مرور جديدة لإكمال تسجيل الدخول.</p>
          <label>كلمة المرور المؤقتة<input name="currentPassword" type="password" autoComplete="current-password" maxLength={128} required /></label>
          <label>كلمة المرور الجديدة<input name="newPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>
          <label>تأكيد كلمة المرور الجديدة<input name="confirmation" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>
          <button disabled={busy}>حفظ كلمة المرور</button>
        </form>
      ) : <p>مرحبًا، <bdi>{session.name}</bdi>.</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <button className="secondary" type="button" onClick={logout} disabled={busy}>تسجيل الخروج</button>
    </Shell>
  )
}

export function App() {
  return onLoginPage ? <Login /> : <Account />
}
