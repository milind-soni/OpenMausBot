import { useEffect, useRef, useState } from "react";

import { usePrefersReducedMotion } from "@/components/mascot-clock";
import { cn } from "@/lib/cn";
import type { Mascot, MascotMood } from "@/vendor/mascot3d/mascot3d.mjs";
import { MASCOT_BRAND } from "../../shared/product";

/** The still of the mascot, rendered from the same model, for no WebGL, reduced motion and the first paint. */
export const BRAND_MASCOT_STILL = "/brand-mascot.png";

/** The brand mascot in 3D. The bundle (three.js inside) loads only when this mounts. */
export function BrandMascot({ width, height, mood = "idle", className }: { width: number; height: number; mood?: MascotMood; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const mascot = useRef<Mascot | null>(null);
  const reduced = usePrefersReducedMotion();
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (reduced) return;
    let cancelled = false;
    let created: Mascot | null = null;
    void import("@/vendor/mascot3d/mascot3d.mjs").then((kit) => {
      if (cancelled || !box.current || !kit.supported()) return;
      created = kit.createMascot(box.current, { brand: MASCOT_BRAND, fps: 30, napAfter: 0 });
      mascot.current = created;
      setLive(true);
    }).catch(() => {});
    return () => {
      cancelled = true;
      created?.dispose();
      mascot.current = null;
      setLive(false);
    };
  }, [reduced]);

  useEffect(() => {
    mascot.current?.setMood(mood);
  }, [mood, live]);

  return (
    <div ref={box} role="img" aria-label={MASCOT_BRAND.name} data-brand-mascot={live ? "live" : "still"}
      className={cn("relative", className)} style={{ width, height }}>
      {!live && <img src={BRAND_MASCOT_STILL} alt="" width={width} height={height} className="absolute inset-0 size-full object-contain" />}
    </div>
  );
}
