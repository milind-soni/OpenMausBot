// MausBot joining the sidebar from its welcome: the rows already there glide down to make room (measured before and
// after, then played back as transforms), the avatar travels from the welcome into the new top slot, and the row shows
// as it lands. Only transform and opacity move, nothing is left behind that catches a click, and with reduced motion
// the row just fades in.
import { flushSync } from "react-dom";

export const LANDING_MS = 640;
export const FLIGHT_MS = 700;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const GLIDE = "cubic-bezier(0.3, 0.7, 0.4, 1)";
/** The sidebar's bot rows and department headings, by a key that survives the re-render. */
function rowsNow(root: ParentNode): Map<string, HTMLElement> {
  const rows = new Map<string, HTMLElement>();
  for (const row of root.querySelectorAll<HTMLElement>("[data-sidebar-bot-row], [data-section]")) {
    const base = row.dataset.sidebarBotRow ? `bot:${row.dataset.sidebarBotRow}` : `section:${row.dataset.section}`;
    let key = base;
    for (let n = 2; rows.has(key); n++) key = `${base}#${n}`;
    rows.set(key, row);
  }
  return rows;
}

const shown = (rect: DOMRect, viewport: number) => rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < viewport;

/** Runs `commit` (the change that adds the row) and plays the landing over it. */
export function landInSidebar({ from, botId, reduced, commit, root = document }: {
  from: HTMLElement | null;
  botId: string;
  reduced: boolean;
  commit: () => void;
  root?: Document;
}): void {
  const viewport = root.defaultView?.innerHeight ?? 0;
  const before = new Map([...rowsNow(root)].map(([id, row]) => [id, row.getBoundingClientRect().top]));
  const start = from?.getBoundingClientRect();
  flushSync(commit);
  const rows = rowsNow(root);
  const row = rows.get(`bot:${botId}`);
  if (!row || !shown(row.getBoundingClientRect(), viewport)) return;
  if (reduced || !from || !start) {
    row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "linear" });
    return;
  }
  const arriving = { duration: FLIGHT_MS + 100, easing: "linear" };
  for (const [key, other] of rows) {
    if (other === row) continue;
    const now = other.getBoundingClientRect();
    if (!shown(now, viewport)) continue;
    const top = before.get(key);
    if (top === undefined) other.animate([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], arriving);
    else if (Math.abs(top - now.top) >= 0.5) other.animate([{ transform: `translateY(${top - now.top}px)` }, { transform: "translateY(0)" }], { duration: LANDING_MS, easing: EASE });
  }
  row.animate([{ opacity: 0 }, { opacity: 0, offset: 0.72 }, { opacity: 1 }], arriving);
  const end = (row.querySelector("svg, img") ?? row).getBoundingClientRect();
  const ghost = from.cloneNode(true) as HTMLElement;
  Object.assign(ghost.style, {
    position: "fixed", left: `${start.left}px`, top: `${start.top}px`, width: `${start.width}px`, height: `${start.height}px`,
    margin: "0", zIndex: "60", pointerEvents: "none", transformOrigin: "top left", filter: "none",
  });
  ghost.setAttribute("aria-hidden", "true");
  root.body.appendChild(ghost);
  from.style.visibility = "hidden";
  const scale = end.width / Math.max(start.width, 1);
  const [dx, dy] = [end.left - start.left, end.top - start.top];
  const flight = ghost.animate([
    { transform: "translate(0, 0) scale(1)" },
    { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 24}px) scale(${(1 + scale) / 2})`, offset: 0.5 },
    { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
  ], { duration: FLIGHT_MS, easing: GLIDE, fill: "forwards" });
  const done = () => ghost.remove();
  flight.onfinish = () => {
    const fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: "linear", fill: "forwards" });
    fade.onfinish = done;
    fade.oncancel = done;
  };
  flight.oncancel = done;
  root.defaultView?.setTimeout(done, FLIGHT_MS + 600);
}
