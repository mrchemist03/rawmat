import { useState } from "react"
import { rejection, request, unavailable } from "./api"

export function CsvExport({ endpoint, filename, query }: { endpoint: string; filename: string; query?: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function download() {
    setBusy(true)
    setError("")
    try {
      const response = await request(endpoint + (query ? "?" + query : ""))
      if (!response.ok) return setError(await rejection(response))
      if (!response.headers.get("Content-Type")?.startsWith("text/csv")) throw new Error()
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement("a")
      link.href = url
      link.download = filename
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch {
      setError(unavailable)
    } finally {
      setBusy(false)
    }
  }
  return <div>
    <button className="secondary" onClick={() => void download()} disabled={busy}>{busy ? "جارٍ التصدير…" : "تصدير CSV"}</button>
    {error && <p role="alert" className="error">{error}</p>}
  </div>
}
