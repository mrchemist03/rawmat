import { createRoot } from "react-dom/client"
import { App } from "./app"
import "@fontsource/tajawal/400.css"
import "@fontsource/tajawal/500.css"
import "@fontsource/tajawal/700.css"
import "./styles.css"

const container = document.getElementById("root")
if (!container) throw new Error("Missing application root")

createRoot(container).render(<App />)
