import { createContext, useCallback, useContext, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

let opened = 0;
const modals: number[] = [];
const ModalLayer = createContext<number | null>(null);
const never = () => () => {};

/**
 * A dialog or sheet drawn with `position: fixed` renders through Layer, which mounts it on `<body>`. Rendered in place,
 * an ancestor with `transform`, `filter` or `backdrop-filter` becomes its containing block (CSS Transforms 1, Filter
 * Effects 1 and 2) and an ancestor's `overflow` or `mask-image` clips it, as Settings' blurred pane does.
 *
 * Render a Layer only while its content is shown: a mounted modal Layer counts as open. On the server, where React
 * cannot portal, the content stays in place.
 */
export function Layer({ modal = false, children }: { modal?: boolean; children: ReactNode }) {
  const [order] = useState(() => ++opened);
  useLayoutEffect(() => {
    if (!modal) return;
    modals.push(order);
    modals.sort((a, b) => a - b);
    return () => { modals.splice(modals.indexOf(order), 1); };
  }, [modal, order]);
  const outer = useContext(ModalLayer);
  const onServer = useSyncExternalStore(never, () => false, () => true);
  const content = <ModalLayer.Provider value={modal ? order : outer}>{children}</ModalLayer.Provider>;
  return onServer ? content : createPortal(content, document.body);
}

/**
 * For a modal's own Escape, Tab and outside-click handlers: whether no modal opened after the one this component sits
 * in is still open. Outside every modal layer it is always true.
 */
export function useIsTopLayer(): () => boolean {
  const order = useContext(ModalLayer);
  return useCallback(() => order === null || modals.at(-1) === order, [order]);
}
