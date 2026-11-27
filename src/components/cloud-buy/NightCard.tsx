// MausBot Cloud's night card, cut like a linocut: the three bots ride a cloud under the moon while this computer's
// laptop sleeps on the hill.
import { memo, useRef, type ReactNode } from "react";
import { MausAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import type { MausColor, MausState } from "@/lib/mascot";
import { useLiveMotion } from "./live-motion";

/** [x, y, radius, seconds per twinkle (0: steady), delay] in the card's 900×120 sky; the scene keeps to x ≥ 600. */
const STARS = [
  [20, 10, 0.7, 0, 0], [420, 108, 0.6, 0, 0], [472, 16, 0.9, 0, 0], [530, 106, 0.7, 0, 0], [566, 12, 1.1, 9, -3],
  [598, 92, 0.7, 0, 0], [742, 10, 0.8, 0, 0], [652, 106, 0.6, 0, 0], [884, 74, 0.8, 0, 0],
] as const;
const SPARKLES = [[640, 20, 4.2], [712, 40, 3], [868, 62, 3.2]] as const;
const CREW: readonly { color: MausColor; state: MausState; spot: readonly [x: number, y: number, size: number] }[] = [
  { color: "orange", state: "working", spot: [636, 52, 28] },
  { color: "pink", state: "idle", spot: [668, 46, 30] },
  { color: "green", state: "thinking", spot: [702, 52, 28] },
];
const Z = "M-2.6-2.6h5.2l-5.2 5.2h5.2";

const sparkle = (r: number) => `M0 ${-r}L${r * 0.22} ${-r * 0.22}L${r} 0L${r * 0.22} ${r * 0.22}L0 ${r}L${-r * 0.22} ${r * 0.22}L${-r} 0L${-r * 0.22} ${-r * 0.22}Z`;

/** The shut laptop, asleep on the near hill: still z's in reduced motion, drifting ones otherwise. */
function Laptop({ moving }: { moving: boolean }) {
  return <g transform="translate(850 98)">
    <ellipse cy="6.2" rx="25" ry="2.6" fill="#000" opacity=".3" />
    <path d="M-23.5 1.6H23.5L21.6 5.2H-21.6Z" fill="var(--cloud-night-laptop-edge)" />
    <path d="M-19.5-6.6H19.5L23.5 1.6H-23.5Z" fill="var(--cloud-night-laptop)" />
    <path d="M-19.5-6.6H19.5L20.1-5.4H-20.1Z" fill="#fff" opacity=".45" />
    <ellipse cy="-2.4" rx="2.2" ry="1.3" fill="var(--cloud-night-laptop-edge)" opacity=".55" />
    <circle cx="17.2" cy="3.4" r=".8" fill="#9df0c4" />
    <g transform="translate(22 -14)">
      {[[0, 0, 0.6], [7, -8, 0.8], [15, -17, 1]].map(([x, y, scale]) =>
        <g key={x} className={moving ? "cloud-night-z" : undefined} transform={`translate(${x} ${y}) scale(${scale})`}>
          <path d={Z} fill="none" stroke="var(--cloud-night-z)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </g>)}
    </g>
  </g>;
}

const Scene = memo(function Scene({ moving }: { moving: boolean }) {
  return <svg aria-hidden="true" viewBox="0 0 900 120" preserveAspectRatio="xMaxYMax slice" className="absolute inset-0 size-full">
    <g fill="var(--cloud-night-star)">
      {STARS.map(([x, y, r, seconds, delay]) => <circle key={`${x}-${y}`} cx={x} cy={y} r={r} opacity={seconds ? undefined : 0.6}
        {...(moving && seconds ? { className: "cloud-night-twinkle", style: { animationDuration: `${seconds}s`, animationDelay: `${delay}s` } } : {})} />)}
    </g>
    <g fill="var(--cloud-night-paper)">
      {SPARKLES.map(([x, y, r]) => <path key={x} transform={`translate(${x} ${y})`} d={sparkle(r)} />)}
    </g>
    {moving && <path className="cloud-night-shoot" d="M600 14l30 9" stroke="var(--cloud-night-star)" strokeWidth="1.2" strokeLinecap="round" />}
    <circle cx="770" cy="44" r="27" fill="var(--cloud-night-paper)" />
    <g fill="none" stroke="var(--cloud-night-carve)" strokeWidth="1.1" strokeLinecap="round">
      <circle cx="760" cy="34" r="4.5" /><circle cx="776" cy="30" r="2.2" /><circle cx="783" cy="50" r="3.2" /><path d="M748 46c1 6 4 11 9 15" />
    </g>
    <path d="M560 120C610 98 662 86 724 90S846 82 900 76V120Z" fill="var(--cloud-night-far)" />
    <path d="M610 120C660 106 712 100 772 104S860 98 900 96V120Z" fill="var(--cloud-night-near)" />
    <g stroke="var(--cloud-night-far)" strokeWidth="1" strokeLinecap="round">
      {[[680, 112], [700, 108], [722, 112], [800, 112], [822, 108], [878, 110]].map(([x, y]) => <path key={x} d={`M${x} ${y}l9-3`} />)}
    </g>
    <g fill="var(--cloud-night-paper)">
      <rect x="622" y="71" width="124" height="21" rx="10.5" />
      <circle cx="656.7" cy="71" r="17.7" /><circle cx="690.2" cy="66.2" r="23.2" /><circle cx="718.7" cy="73" r="16" />
    </g>
    <g fill="none" stroke="var(--cloud-night-carve)" strokeWidth="1" strokeLinecap="round">
      <path d="M640 86c6-4 12-4 18 0" /><path d="M676 82c7-5 15-5 22 0" /><path d="M712 86c5-3 10-3 15 0" />
    </g>
    {CREW.map(({ color, state, spot: [x, y, size] }) => <foreignObject key={color} x={x} y={y} width={size} height={size} overflow="visible">
      <MausAvatar color={color} state={state} size={size} animated={moving} trackPointer={false} />
    </foreignObject>)}
    <Laptop moving={moving} />
  </svg>;
});

/** `children` is the card's text, over the empty sky on the left; the scene keeps right, clear of a close button in the corner.
 * `small` is the Cloud Pro popup's. */
export function NightCard({ small = false, children }: { small?: boolean; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const moving = useLiveMotion(root);
  return <div ref={root} data-night-card="" data-paused={moving ? undefined : ""}
    className={cn("cloud-night relative isolate overflow-hidden rounded-[12px]", small ? "h-[92px]" : "h-[120px]")}>
    <Scene moving={moving} />
    <div className={cn("relative z-10 flex h-full flex-col justify-center", small ? "px-5" : "px-6")}>{children}</div>
  </div>;
}
