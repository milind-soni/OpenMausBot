import { useEffect, useRef, useState } from "react";
import { Check, Cloud, Laptop, Loader2, Trash2 } from "lucide-react";
import { Card } from "./SettingsPrimitives";
import { ComputerSharingSettings } from "./ComputerSharingSettings";
import { CloudMoveSettings } from "./CloudMove";
import { useStore } from "@/state/store";
import { sharedComputersEnabled } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";

type SavedWorkspaces = Awaited<ReturnType<NonNullable<NonNullable<Window["ogb"]>["environments"]>["state"]>>;

/** These are this desktop's connections, not a fleet administration API. */
export function ConnectedWorkspacesSettings() {
  const bridge = window.ogb?.environments;
  // Computer sharing is off unless this workspace's server turned it on. The
  // desktop bridge alone is not enough: never offer access the server refuses.
  const { state } = useStore();
  const sharingOffered = sharedComputersEnabled(state.config) && Boolean(window.ogb?.computerSharing);
  const [saved, setSaved] = useState<SavedWorkspaces | null>(null);
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [computerId, setComputerId] = useState<string | null>(() => new URLSearchParams(window.location?.search ?? "").get("share-computer"));
  // Copy this computer here (docs/copy-workspace.md): this app's own window only.
  const copyOffered = Boolean(window.ogb?.cloudMove) && !window.ogb?.remoteClient?.active;
  // A server's own Copy opens this page on its panel (`copy-to`): the person starts the copy here.
  const [copyId, setCopyId] = useState<string | null>(() => new URLSearchParams(window.location?.search ?? "").get("copy-to"));
  // Local environments (named data dirs, packaged builds only): the create
  // form's fields, the pending Forget, and its keep-or-delete-files choice.
  const [envName, setEnvName] = useState("");
  const [envDir, setEnvDir] = useState("");
  const [envForget, setEnvForget] = useState<string | null>(null);
  const [envPurge, setEnvPurge] = useState(false);
  const [envError, setEnvError] = useState("");
  const pending = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    void bridge?.state().then((state) => { if (generation.current === current) setSaved(state); })
      .catch(() => { if (generation.current === current) setError("Could not load saved servers. Please reopen this page."); });
    return () => { generation.current++; };
  }, [bridge]);
  useEffect(() => {
    const consume = (id?: string | null, panel?: "copy") => {
      if (id) (panel === "copy" ? setCopyId : setComputerId)(id);
      const url = new URL(window.location.href);
      url.searchParams.delete("share-computer");
      url.searchParams.delete("copy-to");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    };
    consume();
    return bridge?.onOpenSettings?.(consume);
  }, [bridge]);
  const perform = async (action: () => Promise<unknown>, fail: (message: string) => void = setError) => {
    if (pending.current || !bridge) return;
    pending.current = true; setBusy(true); setError(""); setEnvError("");
    const current = generation.current;
    try {
      // A successful switch/connect unloads this local renderer. Do not ask
      // for its privileged saved list again after the active origin changes.
      if (await action() === true) return;
      const state = await bridge.state();
      if (generation.current === current) setSaved(state);
    } catch (nextError) {
      if (generation.current === current) fail(String((nextError as Error)?.message ?? nextError)
        .replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ""));
    } finally {
      pending.current = false;
      if (generation.current === current) setBusy(false);
    }
  };
  if (!bridge) return <p className="text-[13px] text-ink-secondary">Manage server connections in the desktop app.</p>;
  const confirmAction = (message: string) => window.ogb?.confirm ? window.ogb.confirm(message) : window.confirm(message);
  const connected = saved?.environments.find(entry => entry.id === computerId);
  const computerWorkspace = connected?.origin ? { id: connected.id, name: connected.name, origin: connected.origin } : undefined;
  const locals = saved?.environments.filter(entry => entry.kind === "local") ?? [];
  const forgetEntry = locals.find(entry => entry.id === envForget);
  return <>
    <p className="text-[13px] leading-relaxed text-ink-secondary">One desktop app, wherever your bots live. Switching servers does not move or replace your bots, conversations, or provider accounts.</p>
    {saved?.packaged && <Card title="Environments on this computer" subtitle="Separate setups on this computer, each with its own bots, conversations and data folder.">
      {envError && <p role="alert" className="text-[12px] text-danger">{envError}</p>}
      {locals.length > 0 && <ul className="divide-y divide-hairline/40">
        {locals.map((entry) => {
          const active = entry.id === saved.activeId;
          return <li key={entry.id} className="flex items-center gap-3 py-3">
            <Laptop size={18} className="shrink-0 text-ink-secondary" />
            <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-medium text-ink">{entry.name}</div>
              <div className="break-all text-[12px] text-ink-secondary">{entry.dataDir}
                {entry.missing && <span className="ml-2 rounded-md bg-inset px-1.5 py-0.5 text-[11px]">missing</span>}</div></div>
            {active ? <span className="flex shrink-0 items-center gap-1 text-[12px] text-ink-secondary"><Check size={13} />Current</span> :
              <button type="button" disabled={busy} aria-label={`Switch to ${entry.name}`}
                onClick={() => void perform(async () => {
                  if (!await confirmAction(`Switch to ${entry.name}? The app restarts on that environment. Running turns stop.`)) return;
                  // Main's error strings are an open set ("dev", "busy", …):
                  // one generic sentence for all of them.
                  const result = await bridge.switch(entry.id);
                  if (result && result.ok === false) throw new Error("Couldn't switch.");
                  return true;
                }, setEnvError)}
                className="rounded-md px-2 py-1.5 text-[12px] text-ink hover:bg-control disabled:opacity-50">Switch</button>}
            {!active && <button type="button" disabled={busy} aria-label={`Forget ${entry.name}`} title={`Forget ${entry.name}`}
              onClick={() => { setEnvForget(entry.id); setEnvPurge(false); }}
              className="rounded-md p-1.5 text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-50"><Trash2 size={14} /></button>}
          </li>;
        })}
      </ul>}
      {forgetEntry && <div className="mt-3 rounded-lg border border-hairline/40 p-3">
        <label className="flex items-start gap-2 text-[12px] leading-relaxed text-ink-secondary">
          <input type="checkbox" checked={envPurge} disabled={busy} className="mt-0.5" onChange={(event) => setEnvPurge(event.target.checked)} />
          Also delete this folder and everything in it ({forgetEntry.dataDir}). Otherwise the folder, its bots and conversations stay on this computer.
        </label>
        <div className="mt-2 flex gap-2">
          <button type="button" disabled={busy} onClick={() => void perform(async () => {
            // Main answers {ok:false} when it refuses or the folder delete fails;
            // the entry stays, so say so generically and leave the panel open.
            const result = envPurge ? await bridge.forget(forgetEntry.id, true) : await bridge.forget(forgetEntry.id);
            if (result && result.ok === false) throw new Error("Couldn't forget the environment.");
            setEnvForget(null);
          }, setEnvError)} className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-danger hover:bg-control disabled:opacity-50">Forget</button>
          <button type="button" onClick={() => setEnvForget(null)} className="rounded-lg px-3 py-1.5 text-[12px] text-ink hover:bg-control">Cancel</button>
        </div>
      </div>}
      <p className="mt-4 text-[13px] font-medium text-ink">New environment</p>
      <form className="flex flex-col gap-3 pt-2" onSubmit={(event) => {
        event.preventDefault();
        if (!envName.trim()) return;
        void perform(async () => {
          // A failure carries main's reason; none of them is a sentence the
          // person can act on, so the form says one generic thing.
          const created = await bridge.create(envName.trim(), envDir.trim() || undefined);
          if (!created?.ok) throw new Error("Couldn't create the environment.");
          setEnvName(""); setEnvDir("");
        }, setEnvError);
      }}>
        <label className="flex flex-col gap-1.5 text-[12px] text-ink-secondary">Name
          <input required value={envName} disabled={busy} maxLength={60} onChange={(event) => setEnvName(event.target.value)} placeholder="My environment"
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink outline-none focus:border-accent/50" />
        </label>
        <label className="flex flex-col gap-1.5 text-[12px] text-ink-secondary">Data folder (optional)
          <span className="flex gap-2">
            <input value={envDir} disabled={busy} onChange={(event) => setEnvDir(event.target.value)} placeholder="Leave empty to create one in your home folder"
              className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink outline-none focus:border-accent/50" />
            <button type="button" disabled={busy} onClick={() => void perform(async () => {
              const picked = await bridge.pickDir();
              if (picked?.ok && picked.path) setEnvDir(picked.path);
            }, setEnvError)} className="shrink-0 rounded-lg border border-hairline/40 px-3 text-[12px] text-ink hover:bg-control disabled:opacity-50">Choose…</button>
          </span>
        </label>
        <button type="submit" disabled={busy || !envName.trim()} className="flex w-fit items-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink disabled:opacity-50">
          {busy && <Loader2 size={14} className="animate-spin" />}Create
        </button>
      </form>
    </Card>}
    <Card title="Your servers" subtitle="Saved on this computer. Your hosted bots keep running when you switch away.">
      {!saved ? <p role="status" className="text-[13px] text-ink-secondary">{error ? "Saved servers could not be loaded." : "Loading servers…"}</p> :
        <ul className="divide-y divide-hairline/40">
          {[{ id: "local", name: "This computer", origin: "" }, ...saved.environments.filter((entry) => entry.kind !== "local")].map((entry) => {
            const active = entry.id === saved.activeId;
            const Icon = entry.id === "local" ? Laptop : Cloud;
            return <li key={entry.id} className="flex items-center gap-3 py-3">
              <Icon size={18} className="shrink-0 text-ink-secondary" />
              <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-medium text-ink">{entry.name}</div>
                <div className="break-all text-[12px] text-ink-secondary">{entry.origin || "Local bots and conversations"}</div></div>
              {active ? <span className="flex shrink-0 items-center gap-1 text-[12px] text-ink-secondary"><Check size={13} />Current</span> :
                <button type="button" disabled={busy} aria-label={`Switch to ${entry.name}`} onClick={() => void perform(async () => { await bridge.switch(entry.id); return true; })}
                  className="rounded-md px-2 py-1.5 text-[12px] text-ink hover:bg-control disabled:opacity-50">Switch</button>}
              {entry.id !== "local" && copyOffered && <button type="button" disabled={busy} aria-label={`${t("cloudMove.here")}: ${entry.name}`} onClick={() => setCopyId(entry.id)} className="rounded-md px-2 py-1.5 text-[12px] text-ink hover:bg-control">{t("cloudMove.here")}</button>}
              {entry.id !== "local" && sharingOffered && <button type="button" disabled={busy} aria-label={`Computer access for ${entry.name}`} onClick={() => setComputerId(entry.id)} className="rounded-md px-2 py-1.5 text-[12px] text-ink hover:bg-control">Computer access</button>}
              {entry.id !== "local" && <button type="button" disabled={busy} aria-label={`Forget ${entry.name}`} title={`Forget ${entry.name}`}
                onClick={() => void perform(() => bridge.forget(entry.id))} className="rounded-md p-1.5 text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-50"><Trash2 size={14} /></button>}
            </li>;
          })}
        </ul>}
    </Card>
    {copyOffered && copyId && saved?.environments.some(entry => entry.id === copyId) && <CloudMoveSettings key={copyId} destination={copyId} onClose={() => setCopyId(null)} />}
    {sharingOffered && computerWorkspace && <ComputerSharingSettings key={computerWorkspace.id} workspace={computerWorkspace} onClose={() => setComputerId(null)} />}
    <Card title="Connect to a server" subtitle="Already running OpenMausBot on a VPS, server, or another computer? Connect it here.">
      <form className="flex flex-col gap-3" onSubmit={(event) => {
        event.preventDefault();
        if (address.trim()) void perform(() => bridge.addFromLink(address.trim(), name.trim()));
      }}>
        <label className="flex flex-col gap-1.5 text-[12px] text-ink-secondary">Server address or pairing link
          <input required value={address} disabled={busy} onChange={(event) => setAddress(event.target.value)}
            placeholder="https://bots.yourcompany.com" autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false}
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink outline-none focus:border-accent/50" />
        </label>
        <label className="flex flex-col gap-1.5 text-[12px] text-ink-secondary">Name (optional)
          <input value={name} disabled={busy} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder="My server"
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink outline-none focus:border-accent/50" />
        </label>
        <p className="text-[12px] leading-relaxed text-ink-secondary">Paste a pairing link from your server’s Settings → Remote access, or enter its address and sign in there. Your desktop stays connected afterward.</p>
        <details className="text-[12px] text-ink-secondary"><summary className="cursor-pointer">Need a pairing code?</summary>
          <p className="mt-2">Run this on the server and copy the link it prints:</p>
          <code className="mt-1 block select-all break-words rounded-md bg-inset px-2 py-2 text-ink">npx openmausbot pair --label "My desktop"</code>
        </details>
        {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
        <button type="submit" disabled={busy || !address.trim()} className="flex w-fit items-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink disabled:opacity-50">
          {busy && <Loader2 size={14} className="animate-spin" />}Connect
        </button>
      </form>
    </Card>
  </>;
}
