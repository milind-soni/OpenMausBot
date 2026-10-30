import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Check, Copy, LoaderCircle } from "lucide-react";
import { claudeSignInLink } from "@/components/ClaudeSignIn";
import { chatgptPlanLink, deviceSignInProvider, type DeviceSignInStatus } from "@/components/DeviceSignIn";
import { needsSignIn } from "@/components/EngineSetup";
import { openExternalLink } from "@/lib/app-links";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { plainSignIn } from "@/lib/onboarding";
import { engineSignedIn } from "@/lib/product-events";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { deviceSignInLink, isDeviceSignInCode } from "../../../shared/device-sign-in";

const POLL_MS = 2_000;
export const PILL = "ui-button ui-button-pill ui-button-lg ui-button-primary w-[288px] max-w-full";

type Slot =
  | { kind: "start" }
  | { kind: "busy" }
  | { kind: "waiting"; flowId: string; link: string | null }
  | { kind: "paste"; flowId: string }
  | { kind: "code"; flowId: string; code: string; link: string | null };

/** How the first screen's pill connects `instance`: in place for a website sign-in or an install the app does itself,
 * else through the Connect an AI dialog. */
export function pillWay(instance: InstanceInfo | undefined): "install" | "sign-in" | "dialog" {
  if (!instance || !plainSignIn(instance)) return "dialog";
  return needsSignIn(instance) ? "sign-in" : "install";
}

/** One AI connected from the first screen's pill: installed (when the app installs it), signed in on the provider's
 * page, and the code pasted or shown in the same place. A finished sign-in refreshes the AIs, where the welcome's test
 * message takes over. */
export function useSignInPill(instance: InstanceInfo | undefined) {
  const { refreshInstances, refreshModels } = useStore();
  const [slot, setSlot] = useState<Slot>({ kind: "start" });
  const [error, setError] = useState<string | null>(null);
  const id = instance?.instanceId ?? "";
  const method = instance?.authentication?.method;
  const base = `/api/instances/${encodeURIComponent(id)}`;
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  const done = useCallback(async () => {
    engineSignedIn(method === "paste-code" ? "claude" : deviceSignInProvider(instance?.driverKind ?? ""),
      method === "browser-pkce" ? "browser" : method === "paste-code" ? "code" : "device_code");
    try { await refreshInstances(); } catch {}
    try { await refreshModels(id); } catch {}
    if (live.current) setSlot({ kind: "start" });
  }, [id, instance?.driverKind, method, refreshInstances, refreshModels]);

  const fail = (cause: unknown) => {
    if (!live.current) return;
    setError(cause instanceof Error ? cause.message : t("engineSetup.device.failed"));
    setSlot({ kind: "start" });
  };

  const install = async () => {
    setSlot({ kind: "busy" });
    setError(null);
    try {
      await api(`${base}/install`, { method: "POST" });
      try { await refreshInstances(); } catch {}
      if (live.current) setSlot({ kind: "start" });
    } catch (cause) { fail(cause); }
  };

  const start = async () => {
    setSlot({ kind: "busy" });
    setError(null);
    try {
      const { auth }: { auth: DeviceSignInStatus } = await api(`${base}/auth/start`, { method: "POST" });
      if (auth.phase === "succeeded") return void await done();
      if (auth.phase !== "waiting" || !auth.flowId) throw new Error(auth.message ?? t("engineSetup.device.failed"));
      if (method === "paste-code") {
        const link = claudeSignInLink(auth.authorizationUrl);
        if (link) await openExternalLink(link).catch(() => {});
        setSlot({ kind: "paste", flowId: auth.flowId });
      } else if (method === "browser-pkce") {
        const link = chatgptPlanLink(auth.authorizationUrl);
        if (link) await openExternalLink(link).catch(() => {});
        setSlot({ kind: "waiting", flowId: auth.flowId, link });
      } else {
        const provider = deviceSignInProvider(instance?.driverKind ?? "");
        const code = isDeviceSignInCode(provider, auth.userCode) ? auth.userCode! : "";
        const link = deviceSignInLink(provider, auth.authorizationUrl, auth.userCode);
        if (link) await openExternalLink(link).catch(() => {});
        setSlot(code ? { kind: "code", flowId: auth.flowId, code, link } : { kind: "waiting", flowId: auth.flowId, link });
      }
    } catch (cause) { fail(cause); }
  };

  const submit = async (code: string) => {
    if (slot.kind !== "paste" || !code.trim()) return;
    const flowId = slot.flowId;
    setSlot({ kind: "busy" });
    setError(null);
    try {
      await api(`${base}/auth/complete`, { method: "POST", body: JSON.stringify({ flowId, code: code.trim() }) });
      await done();
    } catch (cause) {
      fail(cause);
    }
  };

  const polling = slot.kind === "waiting" || slot.kind === "code" ? slot.flowId : null;
  useEffect(() => {
    if (!polling) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      void api(`${base}/auth/status?flowId=${encodeURIComponent(polling)}`, { signal: controller.signal })
        .then(({ auth }: { auth: DeviceSignInStatus }) => {
          if (auth.phase === "succeeded") void done();
          else if (auth.phase !== "waiting") fail(new Error(auth.message ?? t("engineSetup.device.failed")));
        })
        .catch(() => {});
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [polling, base, done]);

  return { slot, error, install, start, submit };
}

type PillState = ReturnType<typeof useSignInPill>;

function CodeSlot({ code }: { code: string }) {
  const { state, copy } = useCopyFeedback(code);
  return (
    <div data-sign-in="code" className="flex h-9 w-[288px] max-w-full items-center justify-between rounded-[18px] border-[0.5px] border-ink/10 bg-composer pl-4 pr-1">
      <span className="font-mono text-[15px] tracking-[0.08em] text-ink">{code}</span>
      <button type="button" onClick={copy} aria-label={t("engineSetup.copy")} title={t("engineSetup.copy")}
        className="flex size-7 items-center justify-center rounded-full text-ink-secondary hover:bg-ink/[0.06] hover:text-ink">
        {state === "copied" ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

function PasteSlot({ name, onSubmit }: { name: string; onSubmit: (code: string) => void }) {
  const [code, setCode] = useState("");
  return (
    <form data-sign-in="paste" className="relative w-[288px] max-w-full" onSubmit={(event) => { event.preventDefault(); onSubmit(code); }}>
      <input autoFocus value={code} onChange={(event) => setCode(event.target.value)} aria-label={t("onboarding.meet.paste", { name })}
        placeholder={t("onboarding.meet.paste", { name })}
        className="h-9 w-full rounded-[18px] border-[0.5px] border-ink/10 bg-composer pl-4 pr-10 text-[14px] leading-5 text-ink placeholder:text-ink-tertiary" />
      <button type="submit" disabled={!code.trim()} aria-label={t("onboarding.meet.pasteSubmit")} title={t("onboarding.meet.pasteSubmit")}
        className="absolute right-1 top-1 flex size-7 items-center justify-center rounded-full bg-ink text-app disabled:opacity-40">
        <ArrowUp size={14} strokeWidth={2} />
      </button>
    </form>
  );
}

/** The first screen's 288×36 slot while an AI is still to connect: its one button, the field for the code a provider
 * shows, or the code to enter on the provider's page. */
export function SignInPill({ pill, instance, waiting, onDialog }: {
  pill: PillState;
  instance: InstanceInfo | undefined;
  /** The test message after a sign-in is under way: the pill waits with it. */
  waiting: boolean;
  onDialog: () => void;
}) {
  const { slot, install, start, submit } = pill;
  const name = instance?.displayName ?? "";
  if (waiting || slot.kind === "busy" || slot.kind === "waiting") {
    const link = slot.kind === "waiting" ? slot.link : null;
    return (
      <button type="button" data-sign-in="waiting" className={PILL} aria-disabled={!link}
        onClick={() => link && void openExternalLink(link).catch(() => {})}>
        <LoaderCircle size={14} aria-hidden="true" className="shrink-0 animate-spin" />{t("onboarding.meet.waiting", { name })}
      </button>
    );
  }
  if (slot.kind === "paste") return <PasteSlot name={name} onSubmit={(code) => void submit(code)} />;
  if (slot.kind === "code") return <CodeSlot code={slot.code} />;
  const way = pillWay(instance);
  const label = way === "install" ? t("onboarding.meet.install", { name })
    : way === "sign-in" ? t("onboarding.meet.signIn", { name })
    : instance ? t("onboarding.meet.connectNamed", { name }) : t("onboarding.meet.connectAi");
  return (
    <button type="button" data-primary="" data-sign-in={way} className={PILL}
      onClick={() => (way === "install" ? void install() : way === "sign-in" ? void start() : onDialog())}>
      {label}
    </button>
  );
}
