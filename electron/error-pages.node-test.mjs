import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { buildErrorPage, showBootFailure } from "./error-pages.mjs";
import nativeText from "./native-text.cjs";

const page = (url) => decodeURIComponent(url.slice("data:text/html;charset=utf-8,".length));
const logDir = path.resolve("/logs");
const logPath = path.join(logDir, "server.log");
const logLink = `<a target="_blank" rel="noopener" href="${pathToFileURL(logPath).href}" style="color:#fcfcfc">${logPath}</a>`;

test("the page for a server that never came up keeps its English, link and all", () => {
  const html = page(buildErrorPage({ allPortsOccupied: false, logDir }));
  assert.match(html, /<h2 style="font-weight:600;margin:12px 0 6px">Couldn't start the bot server<\/h2>/u);
  assert.ok(html.includes("The background server didn&#39;t come up in time — this is usually slow startup, not a port conflict. Quit and reopen OpenMausBot. "
    + `If it keeps happening, check ${logLink}.</p>`));
  assert.ok(page(buildErrorPage({ allPortsOccupied: true, logDir })).includes("Every OpenMausBot port answered health checks from another process"));
});

test("the page speaks the app's language, with the log's link where the sentence puts it", () => {
  const text = nativeText.createNativeText({ saved: "pt-br" });
  const html = page(buildErrorPage({ allPortsOccupied: true, logDir }, text));
  assert.ok(html.includes(">Não foi possível iniciar o servidor dos bots</h2>"));
  assert.equal(html.slice(html.indexOf("<p "), html.indexOf("</p>") + 4),
    '<p style="color:#fcfcfc99;line-height:1.5">Outro processo respondeu às verificações de integridade em todas as portas do OpenMausBot — provavelmente uma segunda cópia do app ou outro programa nas portas 8799–28799. Feche esse programa. Depois, saia do OpenMausBot e abra novamente. '
    + `Se isso continuar acontecendo, confira ${logLink}.</p>`);
});

test("on an always-on home the page says, in one more line, that it keeps trying; without it the page is as before", () => {
  const plainPage = page(buildErrorPage({ allPortsOccupied: true, logDir }));
  const home = page(buildErrorPage({ allPortsOccupied: true, logDir, keepTrying: true }));
  assert.equal(page(buildErrorPage({ allPortsOccupied: true, logDir, keepTrying: false })), plainPage);
  assert.equal(home, plainPage.replace("</p></div>", "</p><p style=\"color:#fcfcfc99;line-height:1.5\">This computer is an always-on home, so it keeps trying to start the server every 5 minutes.</p></div>"));
  const text = nativeText.createNativeText({ saved: "pt-br" });
  assert.ok(page(buildErrorPage({ allPortsOccupied: false, logDir, keepTrying: true }, text)).includes("continua tentando iniciar o servidor a cada 5 minutos"));
});

test("the launch failure box: a server that stopped answering keeps the app open, one that never started quits it", () => {
  const shown = [];
  const dialog = { showErrorBox: (title, body) => shown.push([title, body]) };
  const t = nativeText.englishText.t;
  assert.equal(showBootFailure(dialog, t, { retried: true, folder: "/data" }), false);
  assert.equal(showBootFailure(dialog, t, { retried: false, folder: "/data" }), true);
  assert.deepEqual(shown, [
    [t("native.boot.unhealthy.title"), t("native.boot.unhealthy.body", { folder: "/data" })],
    [t("native.boot.failed.title"), t("native.boot.failed.body", { folder: "/data" })],
  ]);
  assert.notEqual(shown[0][0], shown[1][0]);
  assert.ok(shown[1][1].includes("/data"));
});
