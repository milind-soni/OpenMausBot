import { useStore } from "@/state/store";

/** Opens Files, offering `suggest` (folders on this computer) for sharing. Render it only where cloudFilesBridge() is. */
export function OpenFilesButton({ label, suggest, className = "ui-button" }: { label: string; suggest?: string[]; className?: string }) {
  const { dispatch } = useStore();
  return <button type="button" className={className} onClick={() => dispatch({ type: "showFiles", ...(suggest ? { suggest } : {}) })}>{label}</button>;
}
