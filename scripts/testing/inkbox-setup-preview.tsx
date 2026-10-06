// Real iMessage settings with inert bots. Only the synthetic loopback setup API runs.
import { createRoot } from "react-dom/client";
import { InkboxSetupSection } from "../../src/components/InkboxSetupSection";
import { BotEditorStore, initialState, type Bot } from "../../src/state/store";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { setLocale } from "../../src/lib/i18n";
import { applySkin } from "../../src/lib/skins";
import "../../src/styles.css";

const bots: Bot[] = [
  { id: "fixture-bot", threadId: "fixture-thread", name: "Atlas", title: "", description: "", notifications: false, color: "green", unread: false, modelSelection: { instanceId: "fixture", model: "fixture" }, messages: [] },
  { id: "hidden-fixture-bot", threadId: "hidden-fixture-thread", name: "Hidden", title: "", description: "", notifications: false, color: "green", unread: false, hidden: true, modelSelection: { instanceId: "fixture", model: "fixture" }, messages: [] },
];
setAnalyticsEnabled(false);
setLocale("en");
applySkin("midnight");
createRoot(document.getElementById("root")!).render(<BotEditorStore value={{
  state: { ...initialState, bots }, dispatch: () => {}, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {},
}}><main className="min-h-screen bg-app px-6 py-8 text-ink"><div className="mx-auto max-w-2xl"><h1 className="mb-6 text-2xl font-semibold">Inkbox</h1><InkboxSetupSection /></div></main></BotEditorStore>);
