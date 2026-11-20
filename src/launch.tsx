import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BotAvatar, type BotAvatarProps } from "./components/Avatar";

import { t } from "./lib/i18n";
import { PHONE_LAYOUT } from "./lib/use-media-query";

let faceRoot: Root | undefined;
let started = 0;

export async function withLaunchTimeout<T>(startup: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(t("error.plain.timeout"))), 60_000);
  });
  try {
    return await Promise.race([startup, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const gestures = ["bouncing", "idle", "playful", "idle", "curious", "idle", "happy", "idle"] as const;

function LaunchChief({ bot }: Pick<BotAvatarProps, "bot">) {
  const [gesture, setGesture] = useState(() => Math.floor(Math.random() * (gestures.length / 2)) * 2);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => {
    if (reduced) return;
    const timer = window.setTimeout(() => setGesture(index => (index + 1) % gestures.length), gestures[gesture] === "idle" ? 500 : 1600);
    return () => clearTimeout(timer);
  }, [gesture, reduced]);
  return <BotAvatar bot={bot} size={96} state={gestures[gesture]} trackPointer={false} animated={!reduced} />;
}

export function showLaunchChief(bot: BotAvatarProps["bot"]) {
  faceRoot?.render(<LaunchChief bot={bot} />);
}

export function beginLaunch() {
  const face = document.getElementById("launch-face");
  if (!face) return;
  started = performance.now();
  faceRoot = createRoot(face);
  showLaunchChief({ color: "chrome" });
}

function visibleChief() {
  const selector = matchMedia(PHONE_LAYOUT).matches
    ? "[data-sidebar-hero] [data-avatar]"
    : '[data-sidebar-tile="primary"] [data-launch-chief] [data-avatar]';
  const avatars = document.querySelectorAll<HTMLElement>(selector);
  for (const avatar of avatars) {
    const rect = avatar.getBoundingClientRect();
    if (rect.width && rect.height && rect.left >= 0 && rect.top >= 0 &&
        rect.right <= innerWidth && rect.bottom <= innerHeight && !avatar.closest("[inert]:not(#root), [aria-hidden=true]")) return avatar;
  }
}

export function revealWhenReady() {
  const launch = document.getElementById("launch");
  const face = document.getElementById("launch-face");
  const root = document.getElementById("root");
  if (!root) return;
  if (!launch || !face) {
    launch?.remove();
    root.inert = false;
    return;
  }
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let timer = 0;
  let revealed = false;
  function finish() {
    if (revealed) return;
    revealed = true;
    clearTimeout(timer);
    const mascot = faceRoot;
    faceRoot = undefined;
    try {
      mascot?.unmount();
    } finally {
      launch!.remove();
      root!.inert = false;
    }
  }
  function check() {
    const elapsed = performance.now() - started;
    const waiting = elapsed < 30000 && root!.querySelector("[data-launch-waiting]") &&
      !root!.querySelector('[data-live-connection="offline"], [data-live-connection-retry]');
    if (elapsed < (reduced ? 0 : 840) || waiting) {
      timer = window.setTimeout(check, 80);
      return;
    }
    try {
      const avatar = visibleChief();
      const target = avatar?.getBoundingClientRect();
      const frames: Keyframe[] = [{ transform: "none", opacity: 1 }];
      if (target && !reduced) {
        const origin = face!.getBoundingClientRect();
        const x = target.left + target.width / 2 - origin.left - origin.width / 2;
        const y = target.top + target.height / 2 - origin.top - origin.height / 2;
        const scale = target.width / origin.width;
        frames.push(
          { transform: `translate(${x * .44}px, ${y * .56 - 24}px) rotate(${Math.sign(x) * 6}deg) scale(${.55 + scale * .45})`, offset: .42 },
          { transform: `translate(${x}px, ${y}px) scale(${scale})`, offset: .92, opacity: 1 },
        );
      }
      frames.push({ transform: frames.at(-1)!.transform, opacity: 0 });
      if (avatar && !reduced) {
        avatar.animate([{ opacity: 0 }, { opacity: 0, offset: .9 }, { opacity: 1 }], 740);
      }
      launch!.style.setProperty("--launch-backdrop", "0");
      const duration = reduced ? 160 : 740;
      const flight = face!.animate(frames, { duration, easing: "cubic-bezier(.35,.05,.2,1)", fill: "forwards" });
      flight.onfinish = finish;
      flight.oncancel = finish;
      timer = window.setTimeout(finish, duration + 100);
    } catch {
      finish();
    }
  }
  timer = window.setTimeout(check, 0);
  return () => clearTimeout(timer);
}
