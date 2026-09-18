// The two voice surfaces the docs used to call manual checks, on one page so a
// fixture can photograph them: Settings → Connections (the card that carries
// the Handy engine readout) and the agent voice panel, which carries the
// one-click Piper offer.
//
// The desktop bridge is synthesized rather than the components stubbed,
// because the readout is driven by that bridge: `/__fixture/handy.json`
// answers with a snapshot the recipe measured on this machine through
// electron/handy-engine.mjs, so what renders here is the panel's own output
// from a real install. When that file is absent the bridge is absent too —
// exactly the plain-browser case — and the readout simply does not appear.
//
// Everything above the bridge is the shipped renderer: the same components,
// the same store, the same config API, the same i18n and the same stylesheet.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { SettingsModal } from "../../src/components/SettingsModal";
import { VoiceSettings } from "../../src/components/VoiceSettings";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { StoreProvider, useStore, type Bot } from "../../src/state/store";
import type { HandyEngineStatus } from "../../src/types/ogb";
import { ASTRA_COLOR_NAMES } from "../../src/lib/mascot";
import { applySkin, type SkinId } from "../../src/lib/skins";
import "../../src/styles.css";

/** The agent whose voice panel is on screen. Voice choice is a property of a
 * bot, so the panel needs one; nothing here is persisted. */
const PREVIEW_BOT: Bot = {
  id: "voice-preview-bot",
  threadId: "voice-preview-thread",
  name: "Astra",
  title: "Voice preview",
  description: "",
  notifications: false,
  color: ASTRA_COLOR_NAMES[0],
  unread: false,
  modelSelection: { instanceId: "claude", model: "" },
  /** Piper's default voice: the model the one-click install brings, so the
   * panel has a voice to show the moment the engine arrives. */
  voice: "en_US-amy-medium",
  messages: [],
  speakReplies: true,
};

/** What the capture recipe drives. Exposed instead of scraping the DOM by
 * label, so a rename in the UI cannot silently break the evidence. */
interface PreviewHandle {
  show(view: "settings" | "agent"): void;
  skin(id: SkinId): void;
  /** Scroll the element whose text is exactly `text` into view. */
  scrollTo(text: string): boolean;
  /** Click the first button whose label starts with `label`. */
  click(label: string): boolean;
}

function installBridge(handy: HandyEngineStatus | null): void {
  const capabilities: DesktopCapabilities = {
    host: { platform: "win32", label: "Windows", session: "unknown", packaged: true },
    windowChrome: "native",
    screenPreview: { available: false, interaction: "none", reasonCode: "desktop-app-required" },
    dictation: { available: false, engine: "none", onDevice: false, reasonCode: "unsupported-platform" },
    localComputer: { available: false, support: "unsupported", enabled: false, status: "unavailable", reasonCode: "desktop-app-required" },
  };
  window.ogb = {
    platform: "win32",
    getCapabilities: async () => capabilities,
    onCapabilitiesChanged: () => () => {},
    // No snapshot means no Handy here, which is the honest answer rather than
    // an empty install: `found: false` is what the panel explains.
    ...(handy ? { handyModels: async () => handy } : {}),
  } as Window["ogb"];
}

const byText = (text: string): HTMLElement | null => {
  const wanted = text.trim();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node as HTMLElement;
    if (element.childElementCount === 0 && element.textContent?.trim() === wanted) return element;
  }
  return null;
};

function Preview() {
  const { state, dispatch } = useStore();
  const [view, setView] = useState<"settings" | "agent">("settings");

  useEffect(() => {
    dispatch({ type: "toggleAppSettings", open: view === "settings", section: "connections" });
  }, [dispatch, view]);

  useEffect(() => {
    const handle: PreviewHandle = {
      show: setView,
      skin: (id) => applySkin(id),
      scrollTo: (text) => {
        const element = byText(text);
        element?.scrollIntoView({ block: "center" });
        return Boolean(element);
      },
      click: (label) => {
        const button = [...document.querySelectorAll("button")].find((candidate) =>
          candidate.textContent?.trim().startsWith(label),
        );
        button?.click();
        return Boolean(button);
      },
    };
    (window as unknown as { __voicePreview?: PreviewHandle }).__voicePreview = handle;
  }, []);

  return (
    <>
      <main className="flex min-h-dvh flex-col items-center gap-6 p-8">
        <p className="text-[13px] text-ink-secondary">
          Isolated voice preview · synthesized desktop bridge · real Handy snapshot · no microphone
        </p>
        {view === "agent" ? (
          <div className="w-full max-w-[560px]">
            <VoiceSettings bot={PREVIEW_BOT} onPatch={() => {}} />
          </div>
        ) : null}
      </main>
      {state.appSettingsOpen ? <SettingsModal /> : null}
      <nav
        aria-label="Preview controls"
        className="fixed bottom-1 left-1/2 z-[100] flex -translate-x-1/2 gap-1 rounded-lg border border-hairline bg-panel p-1 text-[11px] text-ink [&_button]:rounded [&_button]:px-2 [&_button]:py-1 [&_button:hover]:bg-control"
      >
        <button onClick={() => setView("settings")}>Settings</button>
        <button onClick={() => setView("agent")}>Agent voice</button>
        <button onClick={() => applySkin("midnight")}>Dark</button>
        <button onClick={() => applySkin("atelier")}>Light</button>
      </nav>
    </>
  );
}

async function boot(): Promise<void> {
  const snapshot: HandyEngineStatus | null = await fetch("/__fixture/handy.json")
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  installBridge(snapshot);
  applySkin("midnight");
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <StoreProvider>
      <DesktopCapabilitiesProvider>
        <Preview />
      </DesktopCapabilitiesProvider>
    </StoreProvider>,
  );
  if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
}

void boot();