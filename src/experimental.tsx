import { createRoot } from "react-dom/client";
import "./styles.css";

// Legacy laboratory only: never selected by a production query string or storage value.
if (import.meta.env.DEV && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
  void import("./App").then(({ default: App }) => createRoot(document.getElementById("root")!).render(<App />));
} else {
  document.getElementById("root")!.textContent = "実験用画面はローカル開発環境専用です。初版の対応範囲には含まれません。";
}
