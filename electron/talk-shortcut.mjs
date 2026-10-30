import { DEFAULT_TALK_KEY, TALK_KEYS } from "./talk-keys.mjs";

const KEY_LIST = Object.entries(TALK_KEYS).map(([id, { label }]) => ({ id, label }));

export const TALK_SHORTCUT_UNAVAILABLE = Object.freeze({ available: false, enabled: false, key: DEFAULT_TALK_KEY, keys: KEY_LIST, taken: false });

export function createTalkShortcut({ globalShortcut, prefs, available, onPress }) {
  let registered = null, taken = false, offered = false;
  const release = () => {
    if (registered) globalShortcut.unregister(registered);
    registered = null;
    taken = false;
  };
  const apply = () => {
    release();
    offered = available();
    if (!offered || !prefs.talkShortcut()) return;
    const { accelerator } = TALK_KEYS[prefs.talkKey()];
    if (globalShortcut.register(accelerator, onPress)) registered = accelerator;
    else taken = true;
  };
  apply();
  const state = () => ({ available: available(), enabled: prefs.talkShortcut(), key: prefs.talkKey(), keys: KEY_LIST, taken });
  return {
    state,
    set(change) {
      if (!available()) return state();
      if (typeof change?.enabled === "boolean") prefs.setTalkShortcut(change.enabled);
      if (change?.key !== undefined) prefs.setTalkKey(change.key);
      apply();
      return state();
    },
    refresh() {
      if (available() !== offered) apply();
    },
    releaseModifiers: () => [...TALK_KEYS[prefs.talkKey()].release],
    close: release,
  };
}

const GONE = ["destroyed", "render-process-gone", "did-navigate"];

export function createCallPresence() {
  const calling = new Map();
  const forget = sender => {
    const stop = calling.get(sender);
    if (!stop) return;
    calling.delete(sender);
    stop();
  };
  return {
    set(sender, active) {
      if (!active) return forget(sender);
      if (calling.has(sender)) return;
      const gone = () => forget(sender);
      for (const event of GONE) sender.on(event, gone);
      calling.set(sender, () => { for (const event of GONE) sender.removeListener(event, gone); });
    },
    active: () => calling.size > 0,
  };
}
