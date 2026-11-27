// Writes the chat-app fixtures the phone apps test against, made by the server's own code, and copies the app
// host page into both phone apps.
//
//   node --experimental-strip-types scripts/gen-app-fixtures.ts <mausbot-mobile checkout>
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AppDocument, AppPayload } from "../shared/app.ts";
import { mcpAppFallbackText } from "../shared/app.ts";
import { mcpAppNetwork } from "../shared/app-frame/csp.ts";
import { APP_HELPER_SOURCE } from "../shared/app-frame/helper.ts";
import { APP_SAMPLES, MCP_APP_SAMPLES } from "../shared/app-samples.ts";
import { AppDocs } from "../server/app-docs.ts";
import { appDocument, createAppCard, setAppContext } from "../server/chat-apps.ts";
import type { Message } from "../server/store.ts";
import { APP_HOST_HTML, appHostHashOf } from "./build-app-host.ts";

export interface AppFixtures {
  messages: Message[];
  documents: Record<string, AppDocument>;
  expectations: Record<string, unknown>;
}

const AT = 1792000000000;
const THREAD = "thread-apps";
const BOT = { id: "bot-scout", name: "Scout" };

export function buildAppFixtures(): AppFixtures {
  const scratch = mkdtempSync(join(tmpdir(), "omb-app-fixtures-"));
  try {
    const docs = new AppDocs(join(scratch, "app-docs"));
    const messages: Message[] = [];
    let nextId = "";
    let clock = AT;
    const store = {
      groupByThread: () => undefined,
      messagesFor: () => messages,
      appendMessage: (_threadId: string, message: Omit<Message, "id" | "at">): Message => {
        const full = { ...message, id: nextId, at: (clock += 1_000) } as Message;
        messages.push(full);
        return full;
      },
      patchMessage: (_threadId: string, messageId: string, patch: Partial<Message>): Message | null => {
        const index = messages.findIndex((message) => message.id === messageId);
        if (index === -1) return null;
        messages[index] = { ...messages[index]!, ...patch };
        return messages[index]!;
      },
    };
    const documents: Record<string, AppDocument> = {};
    const rows: Record<string, unknown> = {};

    for (const [name, sample] of Object.entries(APP_SAMPLES)) {
      nextId = `app-${name}`;
      const result = createAppCard({ store, docs, bot: BOT, threadId: THREAD, input: { tool: "show_html", ...sample } });
      if (!result.ok) throw new Error(`${name}: ${result.error}`);
    }
    nextId = "unused";
    const updated = createAppCard({ store, docs, bot: BOT, threadId: THREAD, input: { tool: "update_html", app_id: "app-report", html: APP_SAMPLES.report!.html.replace("$27.75", "$29.10") } });
    if (!updated.ok) throw new Error(updated.error);
    setAppContext(store, { threadId: THREAD, messageId: "app-counter", content: [{ type: "text", text: "The counter shows 3 cups." }], now: AT + 50_000 });

    for (const [name, sample] of Object.entries(MCP_APP_SAMPLES)) {
      const { csp: _csp, network } = mcpAppNetwork(sample.resourceMeta.csp, sample.loopback);
      const stored = docs.put({ source: "mcp", html: sample.html, data: { tool: sample.tool, toolInput: sample.toolInput, toolResult: sample.toolResult, network } });
      if (!stored.ok) throw new Error(`${name}: not stored`);
      const app: AppPayload = {
        v: 1, source: "mcp", title: sample.tool.title ?? sample.tool.name, doc: stored.doc, rev: 0, bytes: Buffer.byteLength(sample.html),
        border: sample.resourceMeta.prefersBorder ?? true, network,
        mcp: { server: sample.server, serverTitle: sample.serverTitle, tool: sample.tool.name, resourceUri: sample.resourceUri, ...(sample.toolResult.isError ? { isError: true } : {}) },
      };
      nextId = `app-mcp-${name}`;
      store.appendMessage(THREAD, { role: "bot", kind: "app", text: mcpAppFallbackText(sample.serverTitle, app.title, sample.toolResult), app });
    }

    nextId = "app-too-large";
    store.appendMessage(THREAD, { role: "bot", kind: "app", text: "[App] Huge map\nA map too large to keep.", app: {
      v: 1, source: "html", title: "Huge map", doc: "", rev: 0, bytes: 250_000, border: true, network: { connect: [], resources: [] }, blocked: "too-large",
    } });
    nextId = "app-sent";
    store.appendMessage(THREAD, { role: "user", kind: "text", text: "I have had 3 cups of coffee today.", replyToId: "app-counter", sendId: "send-app-0000000001", fromApp: { messageId: "app-counter", title: "Coffee counter" } });
    // What a newer server might send, and a payload this build cannot read.
    nextId = "app-future";
    store.appendMessage(THREAD, { role: "bot", kind: "app", text: "[App] From the future", app: {
      v: 1, source: "html", title: "From the future", doc: "", rev: 0, bytes: 1, border: true, network: { connect: [], resources: [] },
      ...({ hologram: true, displayModes: ["inline", "pip"] } as object),
    } as AppPayload });
    nextId = "app-broken";
    store.appendMessage(THREAD, { role: "bot", kind: "app", text: "An app this build cannot read", app: "nope" as unknown as AppPayload });

    const mcpAccess = () => ({ can: { serverTools: true, serverResources: true, message: true, openLinks: true, modelContext: true } });
    for (const message of messages) {
      if (message.kind !== "app" || !message.app || typeof message.app !== "object") continue;
      const doc = appDocument({ store, docs, threadId: THREAD, messageId: message.id, mcpAccess });
      if (doc) documents[message.id] = doc;
      rows[message.id] = {
        source: message.app.source, title: message.app.title, rev: message.app.rev, border: message.app.border,
        hasDocument: Boolean(doc), ...(message.app.height !== undefined ? { height: message.app.height } : {}),
        ...(message.app.blocked ? { blocked: message.app.blocked } : {}),
        network: message.app.network,
        ...(message.app.context ? { context: message.app.context.text } : {}),
        ...(doc ? { srcdocStartsWith: doc.srcdoc.slice(0, doc.srcdoc.indexOf("\">") + 2), botHelper: doc.srcdoc.includes(APP_HELPER_SOURCE) } : {}),
      };
    }
    const host = readFileSync(APP_HOST_HTML, "utf8");
    return {
      messages,
      documents,
      expectations: { appHostSha256: appHostHashOf(host), sentFrom: { "app-sent": "Coffee counter" }, rows },
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function writeAppFixtures(root: string): string[] {
  const fixtures = buildAppFixtures();
  const dir = join(root, "ios/Tests/CompanionCoreTests/Fixtures");
  mkdirSync(dir, { recursive: true });
  const written = [
    [join(dir, "app-messages.json"), { messages: fixtures.messages, hasMore: false }],
    [join(dir, "app-documents.json"), fixtures.documents],
    [join(dir, "app-expectations.json"), fixtures.expectations],
  ] as const;
  for (const [file, value] of written) writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  const hosts = [join(root, "ios/App/Resources/app-host.html"), join(root, "android/app/src/main/assets/app/app-host.html")];
  for (const target of hosts) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(APP_HOST_HTML, target);
  }
  return [...written.map(([file]) => file), ...hosts];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.argv[2];
  if (!root) throw new Error("usage: gen-app-fixtures.ts <mausbot-mobile checkout>");
  const files = writeAppFixtures(root);
  console.log(`wrote ${files.length} files under ${root}:\n${files.map((file) => `  ${file}`).join("\n")}`);
}
