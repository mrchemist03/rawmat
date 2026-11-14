import { createRoot } from "react-dom/client"

const container = document.getElementById("root")
if (!container) throw new Error("Missing application root")

createRoot(container).render(
  <main>
    <h1>إدارة المواد الأولية</h1>
  </main>,
)
