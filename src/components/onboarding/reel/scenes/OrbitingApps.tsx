// The connectors scene, built in code rather than recorded: connected apps
// orbit the guide on three rings, the way sources orbit the logo in Recall's
// "Save From Anywhere" bento. Rings and badges spring in on a stagger, then
// turn at three speeds; the guide watches, then looks proud once a badge
// gains its check. Under reduced motion the rings hold still.
//
// Logos come from the same resolver the Connected apps page uses: the
// official mark from the Composio catalog when the server has one, else the
// service's favicon, else a monogram. So the scene shows exactly what the
// marketplace will, and still renders offline.
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Check } from "lucide-react";
import { MausAvatar } from "@/components/Avatar";
import { ServiceIcon, type ToolkitCard } from "@/components/PluginsPanel";
import { cn } from "@/lib/cn";
import type { MausState } from "@/lib/mascot";
import { reducedMotion } from "@/lib/onboarding";
import { api } from "@/state/store";

export interface SceneProps {
  playing: boolean;
  onCue?: (state: MausState) => void;
  onEnded?: () => void;
  label: string;
}

const ORBITING_APPS_MS = 5200;

/** The apps on the rings, inner to outer. Domains are the favicon fallback
 * for services the curated catalog does not list; a catalog entry with an
 * official logo always wins. */
const RINGS: Array<Array<{ slug: string; label: string; domain: string }>> = [
  [
    { slug: "gmail", label: "Gmail", domain: "gmail.com" },
    { slug: "slack", label: "Slack", domain: "slack.com" },
    { slug: "github", label: "GitHub", domain: "github.com" },
  ],
  [
    { slug: "notion", label: "Notion", domain: "notion.so" },
    { slug: "linkedin", label: "LinkedIn", domain: "linkedin.com" },
    { slug: "discord", label: "Discord", domain: "discord.com" },
    { slug: "googlecalendar", label: "Calendar", domain: "calendar.google.com" },
  ],
  [
    { slug: "apify", label: "Apify", domain: "apify.com" },
    { slug: "apollo", label: "Apollo", domain: "apollo.io" },
    { slug: "linear", label: "Linear", domain: "linear.app" },
    { slug: "hubspot", label: "HubSpot", domain: "hubspot.com" },
    { slug: "figma", label: "Figma", domain: "figma.com" },
    { slug: "stripe", label: "Stripe", domain: "stripe.com" },
  ],
];

/** Official logos from the catalog, fetched once per session. */
let catalog: Promise<Map<string, ToolkitCard>> | null = null;
function loadCatalog(): Promise<Map<string, ToolkitCard>> {
  catalog ??= api("/api/connectors/catalog")
    .then((d: { cards?: ToolkitCard[] }) => new Map((d.cards ?? []).map((card) => [card.slug, card])))
    .catch(() => new Map<string, ToolkitCard>());
  return catalog;
}

function Badge({ card, connected }: { card: Pick<ToolkitCard, "logo" | "domain" | "label">; connected?: boolean }) {
  return (
    <div className="relative flex flex-col items-center gap-1.5">
      <ServiceIcon card={card} className="size-9 drop-shadow-[0_6px_14px_rgba(0,0,0,0.35)]" />
      <span className="max-w-[56px] truncate text-[9.5px] font-semibold leading-none text-ink-secondary">{card.label}</span>
      {connected && (
        <span className="animate-spot-in absolute -right-1 -top-1.5 flex size-4 items-center justify-center rounded-full bg-success text-white ring-2 ring-inset">
          <Check size={10} strokeWidth={3} />
        </span>
      )}
    </div>
  );
}

function Ring({
  radius,
  duration,
  reverse,
  index,
  still,
  children,
}: {
  radius: number;
  duration: number;
  reverse?: boolean;
  index: number;
  still: boolean;
  children: ReactNode[];
}) {
  const count = children.length;
  return (
    <>
      <div
        className="animate-spot-in pointer-events-none absolute rounded-full border border-hairline/50 bg-gradient-to-b from-ink/[0.04] to-transparent"
        style={{ width: radius * 2, height: radius * 2, left: `calc(50% - ${radius}px)`, top: `calc(50% - ${radius}px)`, animationDelay: `${index * 160}ms` }}
      />
      {children.map((child, i) => (
        <div
          key={i}
          className={cn("absolute left-1/2 top-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center", still ? "" : "animate-orbit")}
          style={
            {
              "--angle": (360 / count) * i,
              "--radius": radius,
              "--duration": `${duration}s`,
              animationDirection: reverse ? "reverse" : undefined,
              // still: place each badge at its starting angle by hand
              transform: still
                ? `translate(-50%, -50%) rotate(${(360 / count) * i}deg) translateY(${radius}px) rotate(${-(360 / count) * i}deg)`
                : undefined,
            } as CSSProperties
          }
        >
          <div className="animate-spot-in" style={{ animationDelay: `${420 + index * 160 + i * 120}ms` }}>
            {child}
          </div>
        </div>
      ))}
    </>
  );
}

export function OrbitingApps({ playing, onCue, onEnded, label }: SceneProps) {
  const still = reducedMotion() || !playing;
  const [connected, setConnected] = useState(still);
  const [logos, setLogos] = useState<Map<string, ToolkitCard>>(new Map());

  useEffect(() => {
    let alive = true;
    void loadCatalog().then((cards) => alive && setLogos(cards));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (still) return;
    onCue?.("curious");
    const check = setTimeout(() => {
      setConnected(true);
      onCue?.("proud");
    }, 2600);
    const end = setTimeout(() => onEnded?.(), ORBITING_APPS_MS);
    return () => {
      clearTimeout(check);
      clearTimeout(end);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [still]);

  const card = (app: { slug: string; label: string; domain: string }) => {
    const known = logos.get(app.slug);
    return { label: app.label, logo: known?.logo ?? null, domain: known?.domain ?? app.domain };
  };

  return (
    <div className="relative h-full w-full overflow-hidden bg-inset" role="img" aria-label={label}>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 h-14 bg-gradient-to-b from-inset to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 h-14 bg-gradient-to-t from-inset to-transparent" />

      {/* the guide, bare, over a soft glow so it still reads as the centre */}
      <div className="absolute left-1/2 top-1/2 z-40 -translate-x-1/2 -translate-y-1/2">
        <div className="absolute inset-0 -m-6 rounded-full bg-accent/15 blur-2xl" aria-hidden="true" />
        <div className="relative drop-shadow-[0_10px_24px_rgba(0,0,0,0.4)]">
          <MausAvatar color="green" state={connected ? "proud" : "curious"} size={76} animated={!still} trackPointer={false} />
        </div>
      </div>

      <div className="relative flex h-full w-full items-center justify-center">
        {RINGS.map((apps, ring) => (
          <Ring key={ring} radius={[92, 140, 186][ring]!} duration={[22, 34, 46][ring]!} reverse={ring !== 1} index={ring} still={still}>
            {apps.map((app, i) => (
              <Badge key={app.slug} card={card(app)} connected={connected && ring === 0 && i === 0} />
            ))}
          </Ring>
        ))}
      </div>
    </div>
  );
}
