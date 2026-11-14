import { useEffect, useRef } from "react"

type Widget = {
  render(element: HTMLElement, options: {
    sitekey: string
    action: string
    language: string
    "response-field": boolean
    callback: (token: string) => void
    "expired-callback": () => void
    "error-callback": () => void
    "timeout-callback": () => void
  }): string
  remove(id: string): void
}

declare global {
  interface Window {
    turnstile?: Widget
  }
}

let scriptPromise: Promise<Widget> | undefined

function loadWidget() {
  scriptPromise ??= new Promise<Widget>((resolve, reject) => {
    const script = document.createElement("script")
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
    script.async = true
    const fail = () => {
      clearTimeout(timeout)
      script.remove()
      scriptPromise = undefined
      reject(new Error("Could not load Turnstile"))
    }
    const timeout = window.setTimeout(fail, 10_000)
    script.addEventListener("load", () => {
      if (!window.turnstile) return fail()
      clearTimeout(timeout)
      resolve(window.turnstile)
    }, { once: true })
    script.addEventListener("error", fail, { once: true })
    document.head.append(script)
  })
  return scriptPromise
}

export function Turnstile({ siteKey, onToken, onError }: {
  siteKey: string
  onToken: (token: string | null) => void
  onError: () => void
}) {
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let widget: Widget | undefined
    let widgetId: string | undefined
    let disposed = false
    const reportError = () => {
      if (disposed) return
      onToken(null)
      onError()
    }
    loadWidget().then((api) => {
      if (disposed || !container.current) return
      widget = api
      widgetId = api.render(container.current, {
        sitekey: siteKey,
        language: "ar",
        action: "login",
        "response-field": false,
        callback: (token) => { if (!disposed) onToken(token) },
        "expired-callback": () => { if (!disposed) onToken(null) },
        "timeout-callback": reportError,
        "error-callback": reportError,
      })
    }).catch(reportError)
    return () => {
      disposed = true
      if (widgetId) widget?.remove(widgetId)
    }
  }, [siteKey, onToken, onError])

  return <div className="challenge" ref={container} />
}
