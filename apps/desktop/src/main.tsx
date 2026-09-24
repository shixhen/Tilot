import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { WorkspacePage } from "./workspace/page";
import "./style.css";

document.documentElement.classList.add("dark");
// 仅 Windows 原生窗口透出 Mica；浏览器预览继续使用模板的实色背景。
if (isTauri() && navigator.userAgent.includes("Windows")) {
  document.documentElement.classList.add("native-mica");
}
createRoot(document.getElementById("root")!).render(<WorkspacePage />);
