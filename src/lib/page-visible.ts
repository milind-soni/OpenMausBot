import { useEffect, useState } from "react";

/** Whether the document is visible. Poll-style effects include this in their
 * deps so a hidden window tears its interval down instead of capturing
 * screenshots nobody can see. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}
