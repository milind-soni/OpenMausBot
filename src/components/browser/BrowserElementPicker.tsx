import { createElement, useEffect, useRef } from "react";
import { mountBrowserPicker, type PickerRead } from "@/lib/browser-picker";

export function BrowserElementPicker({
  scopeKey,
  read,
}: {
  scopeKey: string;
  read: () => PickerRead;
}) {
  const host = useRef<HTMLElement>(null);
  const latest = useRef(read);
  latest.current = read;
  useEffect(
    () =>
      host.current
        ? mountBrowserPicker(host.current, () => latest.current())
        : undefined,
    [scopeKey],
  );
  return createElement("omb-browser-picker", { ref: host });
}
