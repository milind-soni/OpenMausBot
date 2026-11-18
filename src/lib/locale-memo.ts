import { memo, type ReactNode } from "react";
import { activeLocale } from "@/lib/i18n";

const drawnIn = new WeakMap<object, string>();

/** `memo` for a component that reads `t()` or formats dates: it draws again when a prop changes or the language does,
 * which React cannot see. */
export function memoInLocale<P extends object>(component: (props: P) => ReactNode) {
  const Drawn = (props: P) => {
    drawnIn.set(props, activeLocale());
    return component(props);
  };
  Drawn.displayName = component.name;
  return memo(Drawn, (before, after) =>
    drawnIn.get(before) === activeLocale() && Object.keys(after).length === Object.keys(before).length &&
    (Object.keys(after) as (keyof P)[]).every((key) => Object.is(before[key], after[key])));
}
