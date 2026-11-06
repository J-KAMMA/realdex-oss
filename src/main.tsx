import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./v01/V01App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
