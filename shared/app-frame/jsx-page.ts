// The page shell around a show_html `jsx` page: one React component file with a default export. The libraries are
// pinned and come from cdn.jsdelivr.net, which a bot page's CSP already allows, through one import map; nothing is
// bundled into the app. In a chat frame the shell transpiles the file itself with Sucrase; a published page carries
// the server's transpiled code instead and loads no compiler.
import { APP_THEME_STYLE } from "./helper.ts";

/** Exact versions, each at least two weeks old when pinned; `sucrase` matches the server's own dependency. */
export const JSX_PAGE_LIBRARIES = {
  react: "19.3.0",
  "react-dom": "19.3.0",
  "@tailwindcss/browser": "4.3.3",
  "lucide-react": "1.52.0",
  echarts: "6.1.0",
  sucrase: "3.35.1",
} as const;

const NPM = "https://cdn.jsdelivr.net/npm";
const REACT = `${NPM}/react@${JSX_PAGE_LIBRARIES.react}/+esm`;

/** What a page's file may import. `mausbot` is the shell's own: Chart, useTheme, send, open and setContext. */
export const JSX_PAGE_IMPORTS: Readonly<Record<string, string>> = {
  react: REACT,
  "react/jsx-runtime": `${NPM}/react@${JSX_PAGE_LIBRARIES.react}/jsx-runtime/+esm`,
  "react-dom": `${NPM}/react-dom@${JSX_PAGE_LIBRARIES["react-dom"]}/+esm`,
  "react-dom/client": `${NPM}/react-dom@${JSX_PAGE_LIBRARIES["react-dom"]}/client/+esm`,
  "lucide-react": `${NPM}/lucide-react@${JSX_PAGE_LIBRARIES["lucide-react"]}/+esm`,
  echarts: `${NPM}/echarts@${JSX_PAGE_LIBRARIES.echarts}/dist/echarts.esm.min.js`,
};
export const JSX_PAGE_MODULES: readonly string[] = [...Object.keys(JSX_PAGE_IMPORTS), "mausbot"];

const CODEC = `${NPM}/@jridgewell/sourcemap-codec`;
/** Fixes for jsDelivr's on-demand ESM builds, by address. react-dom/client and lucide-react import React by its peer
 * range, or by the newest release when they were built; two copies of React break every hook, so each such address
 * is the one pinned copy. Sucrase's trace-mapping imports named exports from sourcemap-codec 1.5.3's build, which has
 * only a default one; the package's own ESM file has them. */
const IMPORT_REPAIRS: Readonly<Record<string, string>> = {
  [`${NPM}/react@%5E${JSX_PAGE_LIBRARIES.react}/+esm`]: REACT,
  [`${NPM}/react@19.3.1/+esm`]: REACT,
  [`${CODEC}@1.5.3/+esm`]: `${CODEC}@1.5.3/dist/sourcemap-codec.mjs`,
  [`${CODEC}@1.5.4/+esm`]: `${CODEC}@1.5.4/dist/sourcemap-codec.mjs`,
};
export const JSX_PAGE_SUCRASE = `${NPM}/sucrase@${JSX_PAGE_LIBRARIES.sucrase}/+esm`;
export const JSX_PAGE_TAILWIND = `${NPM}/@tailwindcss/browser@${JSX_PAGE_LIBRARIES["@tailwindcss/browser"]}/dist/index.global.js`;

/** The same options in the frame and on the server, so a published page runs the code the preview ran. */
export const JSX_TRANSFORM_OPTIONS = { transforms: ["jsx", "typescript", "imports"], jsxRuntime: "automatic", production: true } as const;

/** JSON, made safe to sit in a script element: no `<` survives, so neither `</script` nor `<!--` can appear. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Plain ES2017 run as written in the page: `(function (env) {…})`. env: { doc, win, load(name), source?, page?, title }.
 * `page(require, module, exports)` is a published page's code; without it `source` is transpiled with Sucrase. */
export const JSX_RUNTIME_SOURCE = `(function (env) {
  "use strict";
  var doc = env.doc, win = env.win;
  var MODULES = ${scriptJson(JSX_PAGE_MODULES)};
  var OPTIONS = ${scriptJson(JSX_TRANSFORM_OPTIONS)};
  var html = doc.documentElement;
  var mount = doc.getElementById("mausbot-root");
  if (!html.getAttribute("data-theme")) {
    var dark = win.matchMedia && win.matchMedia("(prefers-color-scheme: dark)");
    var follow = function () { html.setAttribute("data-theme", dark && dark.matches ? "dark" : "light"); };
    follow();
    if (dark && dark.addEventListener && !(win.mausbot && win.mausbot.send)) dark.addEventListener("change", follow);
  }
  var clip = function (text, limit) { text = String(text == null ? "" : text); return text.length > limit ? text.slice(0, limit - 1) + "\\u2026" : text; };
  var fail = function (kind, message, extra) { var error = new Error(message); error.pageProblem = kind; if (extra) for (var key in extra) error[key] = extra[key]; return error; };
  var offline = function (error) { return fail("offline", "This page needs the internet to load React and its other building blocks. Check the connection, then reload it.", { cause: error }); };
  var lines = function (source, line) {
    var all = String(source || "").split("\\n");
    var from = Math.max(1, line - 2), to = Math.min(all.length, line + 2), out = [];
    for (var n = from; n <= to; n += 1) out.push((n === line ? "> " : "  ") + n + " | " + all[n - 1]);
    return out.join("\\n");
  };
  var describe = function (error) {
    var kind = (error && error.pageProblem) || "run";
    var message = clip(error && error.message ? error.message : String(error), 600);
    var where = error && error.loc && typeof error.loc.line === "number" ? error.loc.line : null;
    return { kind: kind, message: message, line: where, excerpt: where && env.source ? lines(env.source, where) : "" };
  };
  var TITLES = { offline: "This page couldn't load", syntax: "This page's code doesn't read right", "import": "This page asks for something it can't load",
    "export": "This page has nothing to show", run: "This page stopped with an error", render: "This page stopped with an error" };
  var shown = false;
  var report = function (problem) {
    try {
      if (win.mausbot && typeof win.mausbot.setContext === "function") {
        win.mausbot.setContext(clip("The page \\u201c" + env.title + "\\u201d shows an error instead of its content. " + problem.message +
          (problem.line ? " (line " + problem.line + ")" : "") + (problem.excerpt ? "\\n" + problem.excerpt : ""), 1500));
      }
    } catch (ignored) { /* the bridge went away */ }
  };
  var show = function (error) {
    var problem = describe(error);
    if (typeof env.onProblem === "function") env.onProblem(problem);
    if (shown) return problem;
    shown = true;
    var box = doc.createElement("div");
    box.setAttribute("role", "alert");
    box.setAttribute("data-page-problem", problem.kind);
    box.className = "mausbot-problem";
    var title = doc.createElement("strong");
    title.textContent = TITLES[problem.kind] || TITLES.run;
    var body = doc.createElement("p");
    body.textContent = problem.message + (problem.line ? " (line " + problem.line + ")" : "");
    box.appendChild(title);
    box.appendChild(body);
    if (problem.excerpt) {
      var code = doc.createElement("pre");
      code.textContent = problem.excerpt;
      box.appendChild(code);
    }
    var note = doc.createElement("p");
    note.className = "mausbot-problem-note";
    note.textContent = problem.kind === "offline" ? "" : "The bot hears about this with your next message, so it can fix it.";
    if (note.textContent) box.appendChild(note);
    (doc.body || html).appendChild(box);
    report(problem);
    return problem;
  };
  var wrap = function (module) {
    if (module && module.__esModule) return module;
    var out = { __esModule: true };
    for (var key in module) out[key] = module[key];
    out["default"] = module && module["default"] !== undefined ? module["default"] : module;
    return out;
  };
  var shellModule = function (React, echarts) {
    var themeNow = function () { return html.getAttribute("data-theme") === "dark" ? "dark" : "light"; };
    var useTheme = function () {
      var state = React.useState(themeNow());
      React.useEffect(function () {
        var watch = new win.MutationObserver(function () { state[1](themeNow()); });
        watch.observe(html, { attributes: true, attributeFilter: ["data-theme"] });
        return function () { watch.disconnect(); };
      }, []);
      return state[0];
    };
    var Chart = function (props) {
      var box = React.useRef(null), chart = React.useRef(null), theme = useTheme();
      React.useEffect(function () {
        if (!echarts || !box.current) return undefined;
        var made = echarts.init(box.current, theme === "dark" ? "dark" : undefined);
        chart.current = made;
        var sized = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(function () { made.resize(); }) : null;
        if (sized) sized.observe(box.current);
        return function () { if (sized) sized.disconnect(); made.dispose(); chart.current = null; };
      }, [theme]);
      React.useEffect(function () {
        if (chart.current && props.option) chart.current.setOption(Object.assign({ backgroundColor: "transparent" }, props.option), true);
      }, [props.option, theme]);
      return React.createElement("div", { ref: box, className: props.className, role: "img", "aria-label": props.label,
        style: Object.assign({ width: "100%", height: props.height || 320 }, props.style) });
    };
    var bridge = function () { return win.mausbot && typeof win.mausbot.send === "function" ? win.mausbot : null; };
    return {
      __esModule: true, Chart: Chart, useTheme: useTheme,
      send: function (text) { return bridge() ? bridge().send(text) : Promise.resolve(); },
      open: function (url) { if (bridge()) return bridge().open(url); win.open(url, "_blank", "noopener"); return Promise.resolve(); },
      setContext: function (text) { return bridge() ? bridge().setContext(text) : Promise.resolve(); }
    };
  };
  var compile = function () {
    if (typeof env.page === "function") return Promise.resolve(null);
    return env.load("sucrase").then(function (sucrase) {
      try {
        return sucrase.transform(env.source, OPTIONS).code;
      } catch (error) {
        throw fail("syntax", String(error && error.message || error).replace(/\\s*\\(\\d+:\\d+\\)$/, ""), { loc: error && error.loc });
      }
    }, function (error) { throw offline(error); });
  };
  var wanted = function (code) {
    var names = {}, found = [], pattern = /\\brequire\\((["'])([^"']+)\\1\\)/g, match;
    var text = code === null ? String(env.page) : code;
    while ((match = pattern.exec(text))) if (!names[match[2]]) { names[match[2]] = true; found.push(match[2]); }
    return found;
  };
  var run = function () {
    return compile().then(function (code) {
      var names = wanted(code);
      var refused = names.filter(function (name) { return MODULES.indexOf(name) === -1; });
      if (refused.length) {
        throw fail("import", "It imports " + refused.join(", ") + ". A page can import only " + MODULES.join(", ") + ".");
      }
      var needed = ["react", "react-dom/client"];
      names.forEach(function (name) {
        var real = name === "mausbot" ? "echarts" : name;
        if (needed.indexOf(real) === -1) needed.push(real);
      });
      var loaded = {};
      return Promise.all(needed.map(function (name) {
        return env.load(name).then(function (module) { loaded[name] = module; });
      })).then(function () { return { code: code, loaded: loaded }; }, function (error) { throw offline(error); });
    }).then(function (ready) {
      var React = ready.loaded.react;
      var modules = {};
      Object.keys(ready.loaded).forEach(function (name) { modules[name] = wrap(ready.loaded[name]); });
      modules.mausbot = shellModule(React, ready.loaded.echarts);
      var require = function (name) {
        if (!Object.prototype.hasOwnProperty.call(modules, name)) throw fail("import", "It imports " + name + ", which isn't loaded.");
        return modules[name];
      };
      var module = { exports: {} };
      try {
        if (ready.code === null) env.page(require, module, module.exports);
        else new Function("require", "module", "exports", ready.code)(require, module, module.exports);
      } catch (error) {
        if (error && error.pageProblem) throw error;
        throw fail("run", error && error.message ? error.message : String(error));
      }
      var Page = module.exports && module.exports["default"];
      if (typeof Page !== "function" && !(Page && typeof Page === "object")) {
        throw fail("export", "The file must end with export default of the page's component.");
      }
      var client = ready.loaded["react-dom/client"];
      var root = client.createRoot(mount, {
        onUncaughtError: function (error) { show(fail("render", error && error.message ? error.message : String(error))); }
      });
      win.addEventListener("error", function (event) { if (event.error) show(fail("run", event.error.message || String(event.error))); });
      root.render(React.createElement(Page));
      return root;
    }).catch(function (error) { show(error); return null; });
  };
  return run();
})`;

const BASE_STYLE = [
  "html,body{margin:0}",
  "body{font-family:var(--font-sans,system-ui,sans-serif);color:var(--color-text-primary,#1d1d1f);",
  "background:var(--color-background-primary,#fff);-webkit-font-smoothing:antialiased}",
  "#mausbot-root:empty::before{content:\"Loading\\2026\";display:block;padding:24px;font:14px/20px system-ui,sans-serif;opacity:.6}",
  ".mausbot-problem{position:fixed;inset:12px;overflow:auto;z-index:2147483646;border-radius:12px;padding:16px 18px;",
  "font:14px/1.5 system-ui,sans-serif;background:#fff6f5;color:#5c1712;border:1px solid #f3c2bd;box-shadow:0 8px 24px rgba(0,0,0,.12)}",
  "[data-theme=dark] .mausbot-problem{background:#2a1513;color:#ffd9d4;border-color:#6b2a24}",
  ".mausbot-problem strong{display:block;font-size:15px;margin-bottom:6px}.mausbot-problem p{margin:0 0 8px}",
  ".mausbot-problem pre{margin:8px 0;padding:10px 12px;border-radius:8px;background:rgba(0,0,0,.06);font:12px/1.5 ui-monospace,Menlo,monospace;",
  "white-space:pre-wrap;overflow-wrap:anywhere}.mausbot-problem-note{opacity:.75;font-size:12.5px}",
].join("");

/** Tailwind's `dark:` follows the theme the chat hands the page, not only the system setting. */
const TAILWIND_SETUP = "@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));";

function shell(input: { title: string; head: string; boot: string }): string {
  const importMap = { imports: { ...JSX_PAGE_IMPORTS, ...IMPORT_REPAIRS, sucrase: JSX_PAGE_SUCRASE } };
  return [
    "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    `<title>${escapeHtml(input.title)}</title>`,
    `<script type="importmap">${scriptJson(importMap)}</script>`,
    `<script src="${JSX_PAGE_TAILWIND}"></script>`,
    `<style type="text/tailwindcss">${TAILWIND_SETUP}</style>`,
    `<style>${BASE_STYLE}</style>`,
    input.head,
    "</head><body><div id=\"mausbot-root\"></div>",
    `<script type="module">${input.boot}</script>`,
    "</body></html>",
  ].join("");
}

/** The page a chat frame shows: the file rides along as JSON and the frame transpiles it. */
export function jsxPageHtml(input: { title: string; source: string }): string {
  const env = `{ doc: document, win: window, load: function (name) { return import(name); }, title: ${scriptJson(input.title)}, source: ${scriptJson(input.source)} }`;
  return shell({ title: input.title, head: "", boot: `(${JSX_RUNTIME_SOURCE})(${env});` });
}

/** Code inside a script element: a `<` that would start `</script` or `<!--` is escaped, which reads the same in JS. */
export function scriptSafe(code: string): string {
  return code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

/** A published page: the server's transpiled code in a plain function, the theme colours the chat would give it, and no
 * compiler and no eval. */
export function jsxPublishedHtml(input: { title: string; compiled: string }): string {
  const page = `<script>window.__mausbotPage=function(require,module,exports){${scriptSafe(input.compiled)}\n};</script>`;
  const env = `{ doc: document, win: window, load: function (name) { return import(name); }, title: ${scriptJson(input.title)}, page: window.__mausbotPage }`;
  return shell({ title: input.title, head: `<style>${APP_THEME_STYLE}</style>${page}`, boot: `(${JSX_RUNTIME_SOURCE})(${env});` });
}
