// Injected into a bot's page after the CSP meta: theme variables with light and dark defaults, and
// `window.mausbot`, a minimal MCP Apps View on the same bridge as @modelcontextprotocol/ext-apps `App`:
//
//   window.mausbot = {
//     send(text): Promise<void>,        // ui/message
//     open(url): Promise<void>,         // ui/open-link
//     setContext(text): Promise<void>,  // ui/update-model-context
//     theme: "light" | "dark",
//     room: boolean,                    // shown in a room: send and setContext resolve and do nothing
//   }
//
// A page pasted from an SDK build runs its own App beside this one: the helper's request ids are strings
// ("mausbot:1"), never the SDK's numeric ones, and it answers no host request but teardown, so it never
// races the SDK's answer.
import { APP_PROTOCOL_VERSION } from "../app.ts";

export const APP_THEME_STYLE = [
  ":root{color-scheme:light dark;",
  "--color-text-primary:light-dark(#1d1d1f,#ececee);",
  "--color-text-secondary:light-dark(#5f5f66,#a9a9b2);",
  "--color-background-primary:light-dark(#ffffff,#1c1c1f);",
  "--color-background-secondary:light-dark(#f4f4f6,#26262a);",
  "--color-border-primary:light-dark(#d8d8de,#3a3a40);",
  "--font-sans:system-ui,-apple-system,\"Segoe UI\",Roboto,\"Helvetica Neue\",Arial,sans-serif;",
  "--font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
].join("");

/** Plain ES2017 with no imports: it runs as written in every browser engine the apps ship in. */
const helperSource = (room: boolean) => `(function () {
  "use strict";
  var room = ${room};
  var parent = window.parent;
  if (!parent || parent === window) return;
  var root = document.documentElement;
  var seq = 0;
  var pending = {};
  var post = function (message) { parent.postMessage(message, "*"); };
  var request = function (method, params) {
    return new Promise(function (resolve, reject) {
      var id = "mausbot:" + (++seq);
      pending[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: "2.0", id: id, method: method, params: params });
    });
  };
  var notify = function (method, params) { post({ jsonrpc: "2.0", method: method, params: params || {} }); };
  var api = { theme: "light", room: room };
  var apply = function (context) {
    if (!context || typeof context !== "object") return;
    if (context.theme === "light" || context.theme === "dark") {
      api.theme = context.theme;
      root.style.colorScheme = context.theme;
      root.setAttribute("data-theme", context.theme);
    }
    var vars = context.styles && context.styles.variables;
    if (vars && typeof vars === "object") {
      Object.keys(vars).forEach(function (key) {
        if (key.indexOf("--") === 0 && typeof vars[key] === "string") root.style.setProperty(key, vars[key]);
      });
    }
  };
  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.method === undefined) {
      var waiting = typeof message.id === "string" ? pending[message.id] : undefined;
      if (!waiting) return;
      delete pending[message.id];
      if (message.error) waiting.reject(new Error(String(message.error.message || "The host refused this.")));
      else waiting.resolve(message.result);
      return;
    }
    if (message.method === "ui/notifications/host-context-changed") apply(message.params);
    else if (message.method === "ui/resource-teardown" && message.id !== undefined) post({ jsonrpc: "2.0", id: message.id, result: {} });
  });
  // The page's own height, not the frame's: many pages pin html or body to
  // the viewport (height: 100vh, min-height: 100vh) and centre their content
  // in it, which in a frame that sizes to its content only ever reports the
  // frame's current height while the content spills out above and below.
  // Both are freed for the measurement and put back before the next paint.
  var freedHeights = function (elements) {
    var body = document.body;
    var boxes = body ? [root, body] : [root];
    var saved = boxes.map(function (box) { return [box.style.height, box.style.minHeight, box.style.maxHeight]; });
    boxes.forEach(function (box) {
      box.style.setProperty("height", "max-content", "important");
      box.style.setProperty("min-height", "0", "important");
      box.style.setProperty("max-height", "none", "important");
    });
    var heights = elements.map(function (element) { return element.getBoundingClientRect().height; });
    boxes.forEach(function (box, index) {
      box.style.removeProperty("height");
      box.style.removeProperty("min-height");
      box.style.removeProperty("max-height");
      if (saved[index][0]) box.style.height = saved[index][0];
      if (saved[index][1]) box.style.minHeight = saved[index][1];
      if (saved[index][2]) box.style.maxHeight = saved[index][2];
    });
    return heights;
  };
  var isLayer = function (element) {
    var position = window.getComputedStyle(element).position;
    return position === "absolute" || position === "fixed";
  };
  var drawsToWindow = function () {
    var width = window.innerWidth;
    var height = window.innerHeight;
    if (!width || !height || typeof document.elementsFromPoint !== "function") return false;
    var large = document.elementsFromPoint(width / 2, height / 2).filter(function (element) {
      var box = element.getBoundingClientRect();
      return element !== root && element !== document.body && box.width >= width / 2 && box.height >= height / 2;
    });
    if (large.some(isLayer)) return true;
    // Sized from the window with no flow of its own: a map in html, body, #map { height: 100% }.
    return large.length > 0 && freedHeights(large).some(function (freed) { return freed < 1; });
  };
  // A page drawn to its window keeps the frame's starting height until its
  // flow needs more: its layers follow the frame, so what it reports must not.
  var SHORT_FLOW = 120;
  var start = 0;
  var filling = false;
  var heightToReport = function () {
    var flow = Math.ceil(freedHeights([root])[0]);
    if (!start) start = Math.round(window.innerHeight) || 0;
    if (filling && flow < Math.max(start, SHORT_FLOW)) return start;
    filling = start > 0 && flow < SHORT_FLOW && drawsToWindow();
    return filling ? start : flow;
  };
  var watchSize = function () {
    var last = -1;
    var queued = false;
    var later = typeof requestAnimationFrame === "function" ? requestAnimationFrame : function (fn) { return setTimeout(fn, 16); };
    var report = function () {
      if (queued || document.readyState !== "complete") return;
      queued = true;
      later(function () {
        queued = false;
        var height = heightToReport();
        if (height !== last) { last = height; notify("ui/notifications/size-changed", { height: height }); }
      });
    };
    if (typeof ResizeObserver === "function") {
      var observer = new ResizeObserver(report);
      observer.observe(root);
      if (document.body) observer.observe(document.body);
      else document.addEventListener("DOMContentLoaded", function () { if (document.body) observer.observe(document.body); });
    }
    window.addEventListener("load", report);
    report();
  };
  var ready = request("ui/initialize", {
    appInfo: { name: "mausbot-page", version: "1.0.0" },
    appCapabilities: {},
    protocolVersion: "${APP_PROTOCOL_VERSION}"
  }).then(function (result) {
    apply(result && result.hostContext);
    notify("ui/notifications/initialized");
    watchSize();
  });
  var checked = function (result) {
    if (result && result.isError) throw new Error("The host could not do that.");
  };
  api.send = function (text) {
    if (room) return Promise.resolve();
    return ready.then(function () {
      return request("ui/message", { role: "user", content: [{ type: "text", text: String(text) }] });
    }).then(checked);
  };
  api.open = function (url) {
    return ready.then(function () { return request("ui/open-link", { url: String(url) }); }).then(checked);
  };
  api.setContext = function (text) {
    if (room) return Promise.resolve();
    return ready.then(function () {
      return request("ui/update-model-context", { content: [{ type: "text", text: String(text) }] });
    }).then(function () {});
  };
  Object.defineProperty(window, "mausbot", { value: api, enumerable: true });
})();`;

export const APP_HELPER_SOURCE = helperSource(false);
/** A room's page: everyone in the room sees it, and it speaks for none of them. */
export const APP_ROOM_HELPER_SOURCE = helperSource(true);
