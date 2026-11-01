"use client";

import { createElement, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { RotateCw } from "lucide-react";
import { Dialog } from "./dialog";

type LazyOptions = {
  /** The component is a dialog with an `onClose` prop: a failed load shows a small dialog that closes the same way. */
  dialog?: boolean;
};

/**
 * A component whose code loads on first use (or earlier through `preload`). Unlike `next/dynamic` it does not go
 * through Suspense, so a module that arrives quickly shows at once instead of after React's 300ms fallback throttle,
 * and a module that is already loaded renders on the first pass with no fallback at all.
 *
 * A chunk that fails to load (a redeploy removed it, the network dropped) is fetched once more; if that fails too,
 * only this component shows a Reload state, so the board or view around it stays usable.
 */
export function lazyComponent<P extends object>(load: () => Promise<ComponentType<P>>, fallback: ReactNode = null, options: LazyOptions = {}) {
  let loaded: ComponentType<P> | undefined;
  let pending: Promise<ComponentType<P>> | undefined;
  const preload = () => pending ??= load()
    .catch(() => new Promise<ComponentType<P>>(resolve => setTimeout(resolve, 400)).then(load))
    .then(component => (loaded = component), error => {
      // The next use tries again from the start.
      pending = undefined;
      throw error;
    });
  function Lazy(props: P) {
    const [component, setComponent] = useState<{ value?: ComponentType<P>; failed?: boolean }>(() => ({ value: loaded }));
    useEffect(() => {
      if (component.value || component.failed) return;
      let alive = true;
      preload().then(value => { if (alive) setComponent({ value }); }, () => { if (alive) setComponent({ failed: true }); });
      return () => { alive = false; };
    }, [component.value, component.failed]);
    if (component.failed) return <LoadFailed onClose={options.dialog ? (props as { onClose?: () => void }).onClose : undefined} />;
    return component.value ? createElement(component.value, props) : fallback;
  }
  return Object.assign(Lazy, { preload });
}

/** The code for this part of the app is gone or unreachable; a reload fetches the current build. */
function LoadFailed({ onClose }: { onClose?: () => void }) {
  const reload = <button className="primary-button compact" type="button" data-initial-focus onClick={() => window.location.reload()}><RotateCw size={14} />Reload</button>;
  if (onClose) return <Dialog title="Couldn't load" className="load-failed-dialog" onClose={onClose}><div className="dialog-body dialog-actions">{reload}</div></Dialog>;
  return <div className="load-failed" role="alert"><span>Couldn&apos;t load</span>{reload}</div>;
}
