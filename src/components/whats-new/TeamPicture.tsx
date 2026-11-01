// The Team slide's picture: a team's shared bots on its one Cloud, in two departments, and around them each person with
// their own Chief. Drawn with the skin's tokens; the work handed to the shared bots moves only while motion is allowed.
import { memo, useId, useRef } from "react";
import { MausAvatar } from "@/components/Avatar";
import { t } from "@/lib/i18n";
import type { MausColor, MausState } from "@/lib/mascot";
import { useLiveMotion } from "../cloud-buy/live-motion";

type Person = { name: string; color: MausColor; chief: MausColor; x: number; y: number; right: boolean; path: string };
const CHIP = { width: 126, height: 44 };
/** Made-up teammates, clear of the popup's close button at the top right; each path runs from the person's card into the
 * shared Cloud. */
const PEOPLE: readonly Person[] = [
  { name: "Ada", color: "purple", chief: "pink", x: 10, y: 50, right: false, path: "M136 72C160 72 170 92 192 106" },
  { name: "Ben", color: "teal", chief: "green", x: 10, y: 204, right: false, path: "M136 226C162 226 172 210 194 198" },
  { name: "Cleo", color: "coral", chief: "yellow", x: 384, y: 50, right: true, path: "M384 72C360 72 350 92 328 106" },
  { name: "Dara", color: "blue", chief: "cyan", x: 384, y: 204, right: true, path: "M384 226C358 226 348 210 326 198" },
];
type Bot = { color: MausColor; state: MausState; x: number; y: number; size: number };
/** The shared bots by department: each department's main bot, and a helper beside it. */
const DEPARTMENTS: readonly { label: "whatsNew.team.support" | "whatsNew.team.sales"; x: number; bots: readonly Bot[] }[] = [
  { label: "whatsNew.team.support", x: 224, bots: [{ color: "cyan", state: "idle", x: 236, y: 142, size: 24 }, { color: "blue", state: "working", x: 200, y: 130, size: 46 }] },
  { label: "whatsNew.team.sales", x: 298, bots: [{ color: "pink", state: "idle", x: 310, y: 142, size: 24 }, { color: "orange", state: "thinking", x: 274, y: 130, size: 46 }] },
];
const CROWN = "M0 5.5 1.2 0 4 3 6 0 8 3 10.8 0 12 5.5Z";
const ink = (percent: number) => `color-mix(in srgb, var(--color-ink) ${percent}%, transparent)`;
const tint = (color: MausColor, percent: number) => `color-mix(in srgb, var(--identity-${color}) ${percent}%, var(--color-card))`;

/** The Cloud: its pieces drawn once with a line around them and once filled over it, so only its outline shows. */
function CloudShape({ fill, line }: { fill: string; line: string }) {
  const parts = <><rect x="148" y="128" width="224" height="92" rx="46" /><circle cx="208" cy="126" r="48" /><circle cx="266" cy="108" r="60" /><circle cx="326" cy="130" r="42" /></>;
  return <>
    <g fill={line} stroke={line} strokeWidth="2">{parts}</g>
    <g fill={fill}>{parts}</g>
  </>;
}

function PersonCard({ person, moving }: { person: Person; moving: boolean }) {
  const { name, color, chief, x, y, right } = person;
  const avatar = right ? x + CHIP.width - 23 : x + 23, label = right ? x + CHIP.width - 42 : x + 42, chiefX = right ? x + 8 : x + CHIP.width - 34;
  return <g>
    <rect x={x} y={y} width={CHIP.width} height={CHIP.height} rx="14" fill="var(--color-card)" stroke={ink(10)} />
    <circle cx={avatar} cy={y + 22} r="14" fill={tint(color, 24)} />
    <text x={avatar} y={y + 26.5} textAnchor="middle" fontSize="13" fontWeight="600" fill={`var(--identity-${color})`}>{name[0]}</text>
    <text x={label} y={y + 26.5} textAnchor={right ? "end" : "start"} fontSize="13" fontWeight="600" fill="var(--color-ink)">{name}</text>
    <foreignObject x={chiefX} y={y + 12} width="26" height="26" overflow="visible">
      <MausAvatar color={chief} state="idle" size={26} animated={moving} trackPointer={false} />
    </foreignObject>
    <path transform={`translate(${chiefX + 7} ${y + 3})`} d={CROWN} fill="var(--color-warning)" />
  </g>;
}

export const TeamPicture = memo(function TeamPicture({ active }: { active: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const moving = useLiveMotion(root) && active;
  const id = useId(), glow = `${id}-glow`;
  return <div ref={root} className="absolute inset-0" data-team-picture="" data-moving={moving ? "" : undefined}>
    <svg role="img" aria-label={t("whatsNew.team.pictureAlt")} viewBox="0 0 520 260" preserveAspectRatio="xMidYMid meet" className="size-full">
      <defs>
        <radialGradient id={glow} cx="50%" cy="55%" r="50%">
          <stop offset="0" stopColor="var(--color-accent)" stopOpacity="0.16" />
          <stop offset="1" stopColor="var(--color-accent)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="260" cy="152" rx="190" ry="108" fill={`url(#${glow})`} />
      {PEOPLE.map(person => <g key={person.name}>
        <path id={`${id}-${person.name}`} d={person.path} fill="none" stroke={ink(22)} strokeWidth="1.5" strokeDasharray="3 5" strokeLinecap="round" />
        {moving && [0, 1].map(round => <circle key={round} r="3" fill={`var(--identity-${person.color})`} opacity="0">
          <animateMotion dur="3.6s" begin={`${round * 1.8 + PEOPLE.indexOf(person) * 0.45}s`} repeatCount="indefinite"><mpath href={`#${id}-${person.name}`} /></animateMotion>
          <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.8;1" dur="3.6s" begin={`${round * 1.8 + PEOPLE.indexOf(person) * 0.45}s`} repeatCount="indefinite" />
        </circle>)}
      </g>)}
      <CloudShape fill={`color-mix(in srgb, var(--color-accent) 7%, var(--color-card))`} line={ink(12)} />
      {DEPARTMENTS.map(department => <g key={department.label}>
        {department.bots.map(bot => <foreignObject key={bot.color} x={bot.x} y={bot.y} width={bot.size} height={bot.size} overflow="visible">
          <MausAvatar color={bot.color} state={bot.state} size={bot.size} animated={moving} trackPointer={false} />
        </foreignObject>)}
        <text x={department.x} y="198" textAnchor="middle" fontSize="12" fontWeight="600" fill="var(--color-ink-secondary)">{t(department.label)}</text>
      </g>)}
      {PEOPLE.map(person => <PersonCard key={person.name} person={person} moving={moving} />)}
    </svg>
  </div>;
});
