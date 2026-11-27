import { Box, Cloud, Globe, Monitor, Power, Sparkles, type LucideProps } from "lucide-react";
import type { EffectivePlace } from "@/lib/place";

const ICONS = { cloud: Cloud, vm: Box, local: Monitor, browser: Globe, auto: Sparkles, off: Power } as const;

export function PlaceIcon({ place, ...props }: { place: EffectivePlace } & LucideProps) {
  const Icon = ICONS[place];
  return <Icon {...props} />;
}
