import { useEffect, useState } from "react";
import type { TalkKeyId, TalkShortcutState } from "../../electron/talk-shortcut.mjs";
import { t } from "@/lib/i18n";
import { Select } from "./Select";
import { SettingRow, Switch } from "./SettingsPrimitives";

/** Settings search finds the talk shortcut only where its row can show: this Mac app's own page. */
export function talkShortcutKeywords(ogb: Window["ogb"] = typeof window === "undefined" ? undefined : window.ogb): string[] {
  return ogb?.platform === "darwin" && ogb.talkShortcut ? ["talk", "voice", "shortcut", "hotkey", "hold to talk", "push to talk", "quick asks"] : [];
}

export function TalkShortcutRow() {
  const bridge = window.ogb?.talkShortcut;
  const [state, setState] = useState<TalkShortcutState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void bridge?.state().then((next) => { if (live) setState(next); }).catch(() => {});
    return () => { live = false; };
  }, [bridge]);
  if (!bridge || !state?.available) return null;
  const label = state.keys.find((key) => key.id === state.key)?.label ?? "";
  const change = (next: { enabled?: boolean; key?: TalkKeyId }) => {
    setBusy(true); setFailed(false);
    void bridge.set(next).then(setState, () => setFailed(true)).finally(() => setBusy(false));
  };
  const problem = failed ? t("settings.talk.failed") : state.enabled && state.taken ? t("settings.talk.taken", { key: label }) : null;
  const message = (
    <>
      {state.enabled && (
        <Select size="sm" className="w-full max-w-[240px]"
          value={state.key}
          disabled={busy}
          aria-label={t("settings.talk.keyAria")}
          // SAFETY: the options are rendered from state.keys, so the value is always a member.
          onChange={(event) => change({ key: event.target.value as TalkKeyId })}
        >
          {state.keys.map((key) => <option key={key.id} value={key.id}>{key.label}</option>)}
        </Select>
      )}
      {problem && <div role="alert" className={state.enabled ? "mt-2 text-danger" : "text-danger"}>{problem}</div>}
    </>
  );
  return (
    <SettingRow title={t("settings.talk.title")} subtitle={t("settings.talk.subtitle", { key: label })} message={state.enabled || problem ? message : null}>
      <Switch checked={state.enabled} disabled={busy} aria-label={t("settings.talk.aria")} onClick={() => change({ enabled: !state.enabled })} />
    </SettingRow>
  );
}
