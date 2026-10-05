import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/styles/tokens.css";
import "@/styles/app.css";
import { App } from "@/ui/App";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
