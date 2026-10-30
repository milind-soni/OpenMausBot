// Dev-only gallery of the first run's two screens, served at /onboarding-preview.html; not in the packaged app.
// It answers the app's own requests from a fixture, so it needs no server and never touches one.
import { Component, StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { WelcomeFlow } from "@/components/onboarding/WelcomeFlow";
import { Select } from "@/components/Select";
import { EMPTY_ONBOARDING, type BeatId } from "@/lib/onboarding";
import { SKINS, type SkinId } from "@/lib/skins";
import { StoreProvider } from "@/state/store";
import "./styles.css";

/** ?screen=chief&ai=0&bots=3&skin=daylight&reduced=1 opens any state directly; ?w=1338&h=870 sizes the stage. */
function fromUrl() {
  const params = new URLSearchParams(location.search);
  const skin = params.get("skin") as SkinId | null;
  return {
    screen: (params.get("screen") === "chief" ? "chief" : "meet") as BeatId,
    skin: skin && SKINS.some((s) => s.id === skin) ? skin : ("midnight" as SkinId),
    ai: params.get("ai") !== "0",
    bots: Math.max(0, Math.min(20, Number(params.get("bots")) || 0)),
    reduced: params.get("reduced") === "1",
    size: { width: Number(params.get("w")) || 1338, height: Number(params.get("h")) || 870 },
  };
}

const NAMES = ["Research", "Inbox", "Writer", "Scout", "Ledger", "Atlas", "Pixel", "Harbor", "Juniper", "Quill"];
const COLORS = ["blue", "orange", "purple", "teal", "pink", "green", "red", "cyan", "yellow", "coral"] as const;

function bot(id: string, name: string, color: string, extra: Record<string, unknown> = {}) {
  return {
    id, threadId: `${id}-thread`, name, title: "", description: "", notifications: true, color, unread: false, createdAt: 1,
    modelSelection: { instanceId: "claude", model: "sonnet" }, messages: [], tasks: [{ threadId: `${id}-thread`, title: "", createdAt: 1 }], ...extra,
  };
}

function fixture(url: string, ai: boolean, bots: number): unknown {
  const path = new URL(url, location.href).pathname;
  if (path === "/api/bots") {
    return { bots: [
      bot("maus", "MausBot", "chrome", { defaultBot: {}, chiefOfStaff: true }),
      ...Array.from({ length: bots }, (_, i) => bot(`bot-${i}`, NAMES[i % NAMES.length]!, COLORS[i % COLORS.length]!, { title: i % 3 === 0 ? "Finds and summarises" : "" })),
    ], groups: [], sections: [] };
  }
  if (path === "/api/instances") {
    return { instances: [{
      instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", install: { docsUrl: "https://docs.anthropic.com" },
      authentication: { method: "paste-code" }, capabilities: { agentsMcp: true },
      snapshot: { state: "available", authenticated: ai }, models: { default: "sonnet", options: [] },
    }, {
      instanceId: "codex", driverKind: "codex", displayName: "Codex", install: { docsUrl: "https://example.test" },
      snapshot: { state: "unavailable", authenticated: false }, models: { default: "m", options: [] },
    }] };
  }
  if (path === "/api/config") return { onboarding: EMPTY_ONBOARDING, profile: { name: "", email: "", aboutMe: "" } };
  if (path === "/api/auth/session") return { kind: "local" };
  if (path === "/api/routines") return { routines: [], runs: [] };
  if (path === "/api/notifications") return { notifications: [] };
  if (path === "/api/webhooks") return { webhooks: [], attempts: [], ingress: null };
  if (path === "/api/phones") return { phones: [] };
  if (path === "/api/connectors/connected") return { services: {} };
  if (path === "/api/connectors/catalog") return { cards: [] };
  return {};
}

function answerFromFixture(ai: boolean, bots: number) {
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!new URL(url, location.href).pathname.startsWith("/api/")) return real(input, init);
    return new Response(JSON.stringify(fixture(url, ai, bots)), { status: 200, headers: { "content-type": "application/json" } });
  };
}

function Preview() {
  const initial = fromUrl();
  const [skin, setSkin] = useState<SkinId>(initial.skin);
  const [screen, setScreen] = useState<BeatId>(initial.screen);
  const [run, setRun] = useState(0);
  useEffect(() => {
    document.documentElement.dataset.reducedMotion = initial.reduced ? "true" : "false";
    document.documentElement.dataset.skin = skin;
  }, [initial.reduced, skin]);
  const { width, height } = initial.size;
  return (
    <div className="min-h-screen bg-app p-6 text-ink">
      <header className="mb-5 flex flex-wrap items-center gap-3 text-[13px] text-ink-secondary">
        <h1 className="mr-2 text-[18px] font-semibold text-ink">First run</h1>
        <label className="flex items-center gap-1.5">Screen
          <Select size="sm" value={screen} onChange={(e) => { setScreen(e.target.value as BeatId); setRun((r) => r + 1); }}>
            <option value="meet">Meet</option>
            <option value="chief">Chief of Staff</option>
          </Select>
        </label>
        <label className="flex items-center gap-1.5">Skin
          <Select size="sm" value={skin} onChange={(e) => setSkin(e.target.value as SkinId)}>
            {SKINS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </label>
        <button onClick={() => setRun((r) => r + 1)} className="rounded-lg bg-raised px-3 py-1.5 text-ink hover:bg-raised-hover">Replay</button>
        <span className="ml-auto">?ai=0 for no AI, ?bots=3 for bots to choose from</span>
      </header>
      <div className="relative overflow-hidden rounded-xl border border-hairline/40 bg-app" style={{ width, height }}>
        <WelcomeFlow key={`${screen}-${run}`} embedded initialBeat={screen} onDone={() => setRun((r) => r + 1)} />
      </div>
    </div>
  );
}

class Crash extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? <pre className="whitespace-pre-wrap p-6 text-[12px] text-danger">{this.state.error.stack}</pre> : this.props.children;
  }
}

const { ai, bots } = fromUrl();
answerFromFixture(ai, bots);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Crash>
      <DesktopCapabilitiesProvider>
        <StoreProvider>
          <Preview />
        </StoreProvider>
      </DesktopCapabilitiesProvider>
    </Crash>
  </StrictMode>,
);
