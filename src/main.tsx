import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { redactRendererErrorText } from "./lib/renderer-error-redaction";
import { applySkin, readSkin } from "./lib/skins";
import "./styles.css";

// Before the first paint, not inside a component: stamping the skin during
// render would show one frame of the default palette first.
applySkin(readSkin());

interface RendererErrorContext {
  source: "window.error" | "window.unhandledrejection";
  filename?: string;
  line?: number;
  column?: number;
}

function safeRendererLocation(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value, window.location.href);
    return `${parsed.origin}${parsed.pathname}`.slice(0, 1_000);
  } catch {
    return value.split(/[?#]/, 1)[0]?.slice(0, 1_000);
  }
}

function reportRendererError(value: unknown, context: RendererErrorContext) {
  const error = value instanceof Error ? value : new Error(String(value));
  void fetch("/api/telemetry/error", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: error.name,
      message: redactRendererErrorText(error.message),
      stack: redactRendererErrorText(error.stack),
      diagnostics: {
        source: context.source,
        page: safeRendererLocation(window.location.href),
        filename: safeRendererLocation(context.filename),
        line: context.line,
        column: context.column,
      },
    }),
  }).catch(() => {});
}

window.addEventListener("error", (event) => reportRendererError(event.error ?? event.message, {
  source: "window.error",
  filename: event.filename,
  line: event.lineno,
  column: event.colno,
}));
window.addEventListener("unhandledrejection", (event) => reportRendererError(event.reason, {
  source: "window.unhandledrejection",
}));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
