// Run against a fresh, owned `control-omb ui launch` handle, never the live app:
// node --experimental-strip-types scripts/testing/modal-dialog-focus-check.ts UI_HANDLE
import assert from "node:assert/strict";
import { runControlOmb } from "../control-omb.ts";

const handle = process.argv[2];
assert(handle, "Pass the isolated ui launch handle.");
const checked = await runControlOmb(["ui", "eval", "--ui", handle, "--js", String.raw`
(async () => {
  const React = (await import('/node_modules/.vite/deps/react.js')).default;
  const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
  const {useModalDialog} = await import('/src/hooks/use-modal-dialog.ts?focus-check='+Date.now());
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:1000;background:#fff;color:#000';
  document.body.append(host);
  const root = createRoot(host);
  const h = React.createElement;
  const settle = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
  function Dialog({name, onClose, onNext}) {
    const ref = React.useRef(null);
    useModalDialog(ref, onClose);
    return h('div', {ref, role:'dialog', tabIndex:-1, id:'focus-check-'+name},
      h('button', {id:'focus-check-close', onClick:onClose}, 'Close'),
      onNext && h('button', {id:'focus-check-next', onClick:onNext}, 'Next dialog'));
  }
  function Probe() {
    const [name, setName] = React.useState(null);
    return h(React.Fragment, null,
      h('button', {id:'focus-check-opener', onClick:()=>setName('first')}, 'Open'),
      name && h(Dialog, {key:name, name, onClose:()=>setName(null), onNext:name==='first'?()=>setName('second'):undefined}));
  }
  try {
    root.render(h(React.StrictMode, null, h(Probe)));
    await settle();
    const opener = document.getElementById('focus-check-opener');
    opener.focus(); opener.click(); await settle();
    const opened = document.activeElement.id;
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}));
    await settle();
    const restored = document.activeElement.id;
    opener.click(); await settle();
    document.getElementById('focus-check-next').click(); await settle();
    const replaced = document.activeElement.id;
    document.getElementById('focus-check-close').click(); await settle();
    return {opened, restored, replaced, restoredAfterReplacement:document.activeElement.id};
  } finally { root.unmount(); host.remove(); }
})()
`]) as { result: unknown };
assert.deepEqual(checked.result, {
  opened: "focus-check-first",
  restored: "focus-check-opener",
  replaced: "focus-check-second",
  restoredAfterReplacement: "focus-check-opener",
});
console.log(JSON.stringify({ ok: true, ...checked.result as object }));
