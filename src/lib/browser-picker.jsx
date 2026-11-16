import { t } from "./i18n";
import { readPickerDraft as draftReader } from "./browser-picker-draft";
import React from "react";
import { createRoot } from "react-dom/client";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import reset from "@astryxdesign/core/reset.css?inline";
import core from "@astryxdesign/core/astryx.css?inline";
const css =
  reset.replaceAll(":root", ":host") +
  core.replaceAll(":root", ":host") +
  ":host{display:inline-flex;color-scheme:inherit;color:inherit}button{color:inherit}";
const receivers = new Map(),
  viewports = new Map();
export function browserMessage(key, message) {
  if (message.type === "viewport")
    viewports.set(key, { width: message.width, height: message.height });
  receivers.get(key)?.(message);
}
const icon = (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    aria-hidden="true"
  >
    <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M9 8l9 5-5 1-1 5z" />
  </svg>
);
export function mountBrowserPicker(host, read) {
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" }),
    style = document.createElement("style");
  style.textContent = css;
  shadow.append(style);
  const root = createRoot(shadow);
  let alive = true,
    active = false,
    busy = false,
    outline = null,
    status = null,
    statusRoot = null,
    request = null,
    hover = null,
    pending = false,
    last = 0,
    starting = 0;
  const key = read().scopeKey;
  function notice(text) {
    if (!status) {
      status = document.createElement("omb-browser-picker-status");
      const sr = status.attachShadow({ mode: "open" }),
        st = document.createElement("style");
      st.textContent =
        css +
        ":host{position:fixed;inset-block-start:var(--spacing-4);inset-inline-start:var(--spacing-4);z-index:2147483647;background:var(--color-background-popover);color:var(--color-text-primary);border-radius:var(--radius-container);padding:var(--spacing-3);box-shadow:var(--shadow-high)}";
      sr.append(st);
      statusRoot = createRoot(sr);
      document.body.append(status);
    }
    statusRoot.render(
      <HStack gap={2} vAlign="center">
        <Text role="status" aria-live="polite">
          {text}
        </Text>
        <Button
          label={
            active
              ? t("browser.selection.cancel")
              : t("browser.selection.dismiss")
          }
          size="sm"
          variant="secondary"
          onClick={() => {
            cancel();
            clearNotice();
          }}
        />
      </HStack>,
    );
  }
  function clearNotice() {
    statusRoot?.unmount();
    status?.remove();
    status = statusRoot = null;
  }
  function render() {
    if (!alive) return;
    const pill = host.parentElement?.querySelector(
      '[data-pill="yours"],[data-pill="held"]',
    );
    if (active && pill) {
      const colors = getComputedStyle(pill);
      for (const [name, value] of Object.entries({
        background: colors.backgroundColor,
        border: colors.borderColor,
        text: colors.color,
      }))
        host.style.setProperty("--color-browser-selection-" + name, value);
    }
    const selectedStyle = active
      ? {
          color: "var(--color-browser-selection-text,var(--color-text-blue))",
          backgroundColor:
            "var(--color-browser-selection-background,var(--color-background-blue))",
          borderColor:
            "var(--color-browser-selection-border,var(--color-border-blue))",
        }
      : { color: "inherit" };
    root.render(
      <IconButton
        style={selectedStyle}
        aria-pressed={active}
        label={
          active
            ? t("browser.selection.cancelLabel")
            : t("browser.selection.selectLabel")
        }
        title={
          active
            ? t("browser.selection.activeHint")
            : t("browser.selection.selectHint")
        }
        icon={icon}
        variant={active ? "secondary" : "ghost"}
        size="sm"
        isLoading={busy}
        onClick={() => (active ? cancel() : start())}
      />,
    );
  }
  function cancel(keepBusy = false) {
    if (!keepBusy) busy = false;
    active = false;
    starting++;
    hover = null;
    request = null;
    pending = false;
    outline?.remove();
    outline = null;
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("pointerdown", down, true);
    document.removeEventListener("pointerup", down, true);
    document.removeEventListener("click", click, true);
    document.removeEventListener("keydown", escape, true);
    window.removeEventListener("resize", cancel);
    render();
  }
  function escape(e) {
    if (e.key === "Escape" && active) {
      e.preventDefault();
      e.stopImmediatePropagation();
      cancel();
      clearNotice();
    }
  }
  function point(e) {
    const canvas = read().surface(),
      v = viewports.get(key);
    if (!canvas || !v || e.target !== canvas) return null;
    const b = canvas.getBoundingClientRect(),
      scale = Math.min(b.width / canvas.width, b.height / canvas.height),
      w = canvas.width * scale,
      h = canvas.height * scale,
      left = b.left + (b.width - w) / 2,
      top = b.top + (b.height - h) / 2;
    const x = ((e.clientX - left) * v.width) / w,
      y = ((e.clientY - top) * v.height) / h;
    return x >= 0 && y >= 0 && x < v.width && y < v.height
      ? { x, y, b, left, top, w, h, v }
      : null;
  }
  function show(element) {
    const canvas = read().surface(),
      v = viewports.get(key);
    if (!canvas || !v || !element?.rect) return;
    const b = canvas.getBoundingClientRect(),
      scale = Math.min(b.width / canvas.width, b.height / canvas.height),
      w = canvas.width * scale,
      h = canvas.height * scale,
      left = b.left + (b.width - w) / 2,
      top = b.top + (b.height - h) / 2,
      r = element.rect;
    if (!outline) {
      outline = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      outline.setAttribute("aria-hidden", "true");
      Object.assign(outline.style, {
        position: "fixed",
        inset: "0",
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: "2147483646",
        color: "Highlight",
      });
      const rect = document.createElementNS(outline.namespaceURI, "rect");
      rect.setAttribute("fill", "none");
      rect.setAttribute("stroke", "currentColor");
      rect.setAttribute("stroke-width", "2");
      outline.append(rect);
      document.body.append(outline);
    }
    for (const [k, value] of Object.entries({
      x: left + (r.x * w) / v.width,
      y: top + (r.y * h) / v.height,
      width: (r.width * w) / v.width,
      height: (r.height * h) / v.height,
    }))
      outline.firstChild.setAttribute(k, String(value));
  }
  function issue(p, capture) {
    const id = crypto.randomUUID();
    request = {
      id,
      capture,
      draft: draftReader?.(),
      draftId: draftReader?.().draftId,
    };
    pending = true;
    let sent;
    try {
      sent = read().send({
        type: "ombElementInspect",
        requestId: id,
        x: p.x,
        y: p.y,
        capture,
        ...(hover?.document ? { document: hover.document } : {}),
      });
    } catch {
      sent = false;
    }
    if (sent === false) {
      cancel();
      notice(t("browser.selection.controlChanged"));
    }
  }
  function move(e) {
    if (!active || busy) return;
    const p = point(e);
    if (!p) {
      outline?.remove();
      outline = null;
      return;
    }
    if (!pending && performance.now() - last > 100) {
      last = performance.now();
      issue(p, false);
    }
  }
  function down(e) {
    if (active && point(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
  function click(e) {
    const p = point(e);
    if (!active || !p || busy) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const draft = draftReader?.();
    if (!draft?.allowImages) {
      notice(t("browser.selection.imagesUnsupported"));
      return;
    }
    if (draft.recording) {
      notice(t("browser.selection.finishDictation"));
      return;
    }
    if (draft.imageSlots !== undefined && draft.imageSlots < 1) {
      notice(t("browser.selection.removeImage"));
      return;
    }
    busy = true;
    issue(p, true);
    render();
  }
  async function receive(message) {
    if (message.type === "ombPickerControl") {
      if (active && message.controller !== "you") {
        cancel();
        notice(t("browser.selection.controlChanged"));
      }
      return;
    }
    if (
      message.type === "nav" ||
      message.type === "tabs" ||
      message.type === "url"
    ) {
      let next = message.url;
      if (message.type === "tabs")
        next = message.tabs?.find((tab) => tab.active)?.url;
      try {
        if (next) {
          const u = new URL(next);
          u.search = "";
          u.hash = "";
          u.username = "";
          u.password = "";
          next = u.href;
        }
      } catch {
        next = null;
      }
      if (active && hover && next && next !== hover.url) {
        cancel();
        notice(t("browser.selection.pageChanged"));
      }
      return;
    }
    if (
      message.type !== "ombElementInspection" ||
      !request ||
      message.requestId !== request.id
    )
      return;
    const job = request;
    pending = false;
    request = null;
    if (message.error) {
      if (job.capture) {
        busy = false;
        notice(message.error);
        render();
      }
      return;
    }
    if (!active) return;
    hover = message.element;
    show(hover);
    if (!job.capture) return;
    const current = draftReader?.();
    if (!message.image || !current || current.draftId !== job.draftId) {
      busy = false;
      cancel();
      notice(t("browser.selection.conversationChanged"));
      return;
    }
    try {
      const data = Uint8Array.from(atob(message.image), (c) => c.charCodeAt(0));
      if (data.length > Math.min(8000000, current.imageBytes ?? 8000000))
        throw Error(t("browser.selection.smaller"));
      const element = message.element;
      cancel(true);
      await current.onFiles([
        new File([data], "browser-selected-element.png", { type: "image/png" }),
      ]);
      const latest = draftReader?.();
      if (latest?.draftId === job.draftId) {
        const context =
          "[Selected browser element]\n" +
          element.url +
          "\n" +
          element.tag +
          ": " +
          element.selector +
          (element.label ? "\n" + element.label : "");
        latest.onText(
          latest.getText() + (latest.getText() ? "\n\n" : "") + context,
        );
      }
      notice(t("browser.selection.added"));
    } catch (error) {
      notice(error.message || t("browser.selection.failed"));
    } finally {
      busy = false;
      render();
    }
  }
  async function start() {
    const props = read(),
      d = draftReader?.();
    if (!props.connected || !props.surface()) {
      notice(t("browser.selection.waitForPage"));
      return;
    }
    if (!d) {
      notice(t("browser.selection.openConversation"));
      return;
    }
    if (d.recording) {
      notice(t("browser.selection.finishDictation"));
      return;
    }
    const run = ++starting;
    if (props.control?.controller !== "you") {
      props.take();
      for (
        let i = 0;
        i < 100 &&
        alive &&
        run === starting &&
        read().control?.controller !== "you";
        i++
      )
        await new Promise((r) => setTimeout(r, 100));
    }
    if (!alive || run !== starting) return;
    if (read().control?.controller !== "you") {
      notice(t("browser.selection.takeControl"));
      return;
    }
    active = true;
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", down, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", cancel);
    notice(t("browser.selection.instructions"));
    render();
  }
  const themeObserver = new MutationObserver(() => {
    if (active) render();
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-skin"],
  });
  receivers.set(key, receive);
  render();
  return () => {
    themeObserver.disconnect();
    alive = false;
    cancel();
    clearNotice();
    if (receivers.get(key) === receive) receivers.delete(key);
    root.unmount();
  };
}
