import { useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { Laptop, Loader2, Unplug } from "lucide-react";
import { Card } from "./SettingsPrimitives";

const inputClass =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

function errorText(error: unknown): string {
  return String((error as { message?: string })?.message ?? error).replace(
    /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/,
    "",
  );
}

export function isServerPairingLink(input: string): boolean {
  const link = input.trim();
  if (!/^https:\/\//i.test(link) || /[\s\\]/.test(link)) return false;
  try {
    const url = new URL(link);
    const code = /(?:^|[#&])code=([^&]+)/.exec(url.hash)?.[1];
    return url.protocol === "https:" && !url.username && !url.password && !url.search
      && (url.pathname === "/pair" || url.pathname === "/pair/")
      && Boolean(code && decodeURIComponent(code).trim());
  } catch {
    return false;
  }
}

export function RemoteComputerSection() {
  const bridge = window.ogb?.remoteClient;
  const environments = window.ogb?.environments;
  const [state, setState] = useState<DesktopRemoteClientState>({ active: bridge?.active === true });
  const [connection, setConnection] = useState<"server" | "companion">(environments ? "server" : "companion");
  const [serverLink, setServerLink] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const serverMode = Boolean(environments) && connection === "server";

  useEffect(() => {
    let alive = true;
    void bridge?.state().then((next) => alive && setState(next)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [bridge]);

  const pair = async () => {
    if (pending.current || (!bridge && !environments)) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (serverMode && environments) {
        if (!isServerPairingLink(serverLink)) throw new Error(t("remote.client.server.invalidLink"));
        await environments.addFromLink(serverLink.trim());
      } else if (bridge) {
        setState(await bridge.pair(endpoint, code));
      }
    } catch (nextError) {
      setError(errorText(nextError));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!bridge || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await bridge.disconnect();
    } catch (nextError) {
      setError(errorText(nextError));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <Card
      title={state.active ? t("remote.client.active") : t("remote.client.idle")}
      subtitle={t("remote.client.subtitle")}
    >
      {!bridge && !environments ? (
        <p className="text-[13px] text-ink-secondary">{t("remote.client.desktopOnly")}</p>
      ) : state.active ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3 rounded-lg border border-success/25 bg-success/10 px-3 py-3">
            <Laptop size={18} className="mt-0.5 shrink-0 text-success" />
            <div className="min-w-0">
              <div className="text-[14px] font-medium text-ink">
                {t("remote.client.connected", { name: state.serverName || t("remote.client.fallbackName") })}
              </div>
              <div className="mt-1 break-all text-[12px] text-ink-secondary">{state.endpoint}</div>
            </div>
          </div>
          <p className="text-[12.5px] leading-relaxed text-ink-secondary">
            {t("remote.client.mode")}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void disconnect()}
            className="flex w-fit items-center gap-2 rounded-lg border border-danger/30 px-3 py-2 text-[13px] text-danger hover:bg-danger/10 disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Unplug size={14} />}
            {t("remote.client.disconnect")}
          </button>
        </div>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void pair(); }}>
          {environments && bridge ? (
            <label className="flex flex-col gap-1.5 text-[12px] text-ink-secondary">
              {t("remote.client.connectionType")}
              <select
                value={connection}
                disabled={busy}
                onChange={(event) => {
                  setConnection(event.target.value as "server" | "companion");
                  setError("");
                }}
                className={inputClass}
              >
                <option value="server">{t("remote.client.server.option")}</option>
                <option value="companion">{t("remote.client.companion.option")}</option>
              </select>
            </label>
          ) : null}
          {serverMode ? (
            <>
              <p className="text-[12.5px] leading-relaxed text-ink-secondary">
                {t("remote.client.server.hint")}
              </p>
              <code className="select-all rounded-lg bg-inset px-3 py-2 text-[12px] text-ink">
                npx openmausbot pair --client
              </code>
              <label className="flex flex-col gap-1.5 text-[12px] text-ink-secondary">
                {t("remote.client.server.pairingLink")}
                <input
                  value={serverLink}
                  onChange={(event) => setServerLink(event.target.value)}
                  placeholder="https://bots.example.com/pair#code=XXXX-XXXX-XXXX"
                  disabled={busy}
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  className={inputClass}
                />
              </label>
              <p className="text-[11.5px] leading-relaxed text-ink-secondary">
                {t("remote.client.server.domainHint")}
              </p>
            </>
          ) : (
            <>
              <p className="text-[12.5px] leading-relaxed text-ink-secondary">
                {t("remote.client.companion.hint")}
              </p>
              <label className="flex flex-col gap-1.5 text-[12px] text-ink-secondary">
                {t("remote.client.companion.address")}
                <input
                  value={endpoint}
                  onChange={(event) => setEndpoint(event.target.value)}
                  placeholder="https://…openmausbot.com or computer.tailnet.ts.net"
                  disabled={busy}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className={inputClass}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-[12px] text-ink-secondary">
                {t("remote.client.companion.code")}
                <input
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  disabled={busy}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  className={`${inputClass} max-w-40 font-mono tracking-[0.2em]`}
                />
              </label>
            </>
          )}
          {error ? <p role="alert" className="text-[12.5px] text-danger">{error}</p> : null}
          <button
            type="submit"
            disabled={busy || (serverMode ? !serverLink.trim() : endpoint.trim() === "" || code.length !== 6)}
            className="flex w-fit items-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Laptop size={14} />}
            {serverMode ? t("remote.client.server.connect") : t("remote.client.pair")}
          </button>
          <p className="text-[11.5px] leading-relaxed text-ink-secondary">
            {serverMode ? t("remote.client.server.switchNote") : t("remote.client.restartNote")}
          </p>
        </form>
      )}
      {state.active && error ? <p role="alert" className="mt-3 text-[12.5px] text-danger">{error}</p> : null}
    </Card>
  );
}
