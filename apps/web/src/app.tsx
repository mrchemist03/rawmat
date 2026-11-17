import { useCallback, useEffect, useState } from "react"
import type { FormEvent, ReactNode } from "react"
import { changePasswordSchema, loginConfigSchema, loginSchema, meSchema, sessionViewSchema } from "@rawmat/shared"
import type { NavigationItem } from "@rawmat/shared"
import type { z } from "zod"
import { rejection, request, unavailable } from "./api"
import { Accounts, Branches } from "./management"
import { Materials, References } from "./catalogue"
import { Audit } from "./audit"
import { Purchases } from "./purchases"
import { Shipments } from "./shipments"
import { Notifications } from "./notifications"
import { Overview } from "./overview"
import { Turnstile } from "./turnstile"

type Session = z.infer<typeof sessionViewSchema>
const onLoginPage = window.location.pathname === "/login"

function Branding() {
  return (
    <span className="brand">
      <img src="/branding/logo.png" alt="" width="44" height="44" />
      <span>إدارة المواد الأولية</span>
    </span>
  )
}

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="layout">
      <section className="panel" aria-labelledby="page-title">
        <header><Branding /><h1 id="page-title">{title}</h1></header>
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
      setError("اختر كلمة مرور مختلفة طولها 12 حرفًا على الأقل.")
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

  if (!session.mustChangePassword) return <Workspace onLogout={logout} busy={busy} error={error} />

  return (
    <Shell title="تغيير كلمة المرور">
        <form onSubmit={changePassword}>
          <p>عيّن كلمة مرور جديدة لإكمال تسجيل الدخول.</p>
          <label>كلمة المرور المؤقتة<input name="currentPassword" type="password" autoComplete="current-password" maxLength={128} required /></label>
          <label>كلمة المرور الجديدة<input name="newPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>
          <label>تأكيد كلمة المرور الجديدة<input name="confirmation" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>
          <button disabled={busy}>حفظ كلمة المرور</button>
        </form>
      {error && <p role="alert" className="error">{error}</p>}
      <button className="secondary" type="button" onClick={logout} disabled={busy}>تسجيل الخروج</button>
    </Shell>
  )
}

const navigation: Record<NavigationItem, { path: string; title: string }> = {
  overview: { path: "/", title: "النظرة العامة" },
  account: { path: "/account", title: "حسابي" },
  materials: { path: "/materials", title: "المواد الأولية" },
  purchases: { path: "/purchases", title: "طلبات الشراء" },
  shipments: { path: "/shipments", title: "الشحنات" },
  notifications: { path: "/notifications", title: "التنبيهات" },
  accounts: { path: "/accounts", title: "الحسابات" },
  branches: { path: "/branches", title: "الشعب" },
  references: { path: "/references", title: "القوائم المرجعية" },
  audit: { path: "/audit", title: "سجل التدقيق" },
}

function Workspace({ onLogout, busy, error }: { onLogout: () => void; busy: boolean; error: string }) {
  const [profile, setProfile] = useState<z.infer<typeof meSchema>>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    request("/api/me").then(async (response) => {
      if (response.status === 401) return window.location.replace("/login")
      if (response.status === 403) return window.location.replace("/")
      if (!response.ok) throw new Error()
      setProfile(meSchema.parse(await response.json()))
    }).catch(() => setFailed(true))
  }, [])

  if (!profile) {
    return <Shell title="الحساب"><p role={failed ? "alert" : "status"}>{failed ? unavailable : "جارٍ تحميل الحساب…"}</p></Shell>
  }

  const current = profile.navigation.find((item) => navigation[item].path === window.location.pathname) ?? "account"
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="home" href="/"><Branding /></a>
          <nav aria-label="التنقل الرئيسي">
            {profile.navigation.map((item) => (
              <a key={item} href={navigation[item].path} aria-current={item === current ? "page" : undefined}>
                {navigation[item].title}
              </a>
            ))}
          </nav>
          <button className="secondary" onClick={onLogout} disabled={busy}>تسجيل الخروج</button>
        </div>
      </header>
      <main className="workspace">
        {error && <p className="error" role="alert">{error}</p>}
        {current === "overview" && <Overview />}
        {current === "accounts" && <Accounts />}
        {current === "branches" && <Branches />}
        {current === "materials" && <Materials />}
        {current === "purchases" && <Purchases />}
        {current === "shipments" && <Shipments />}
        {current === "notifications" && <Notifications />}
        {current === "references" && <References />}
        {current === "audit" && <Audit />}
        {current === "account" && <section className="surface"><h1>حسابي</h1><p>مرحبًا، <bdi>{profile.name}</bdi>.</p></section>}
      </main>
    </>
  )
}

export function App() {
  return onLoginPage ? <Login /> : <Account />
}
