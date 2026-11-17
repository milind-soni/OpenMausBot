import { useState, type ComponentType } from "react";
import { Lightbulb, Megaphone, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { activeLocale } from "@/lib/i18n";
import type { Action } from "@/state/store";
import {
  localized, type AnnouncementAction, type AnnouncementCard as Card, type AnnouncementKind, type AnnouncementMark, type AnnouncementPlace,
} from "../../shared/announcements";
import { openKeySettings } from "./keys/key-focus";
import { LinkButton, NoticeCard, NotNowButton, PRIMARY_BUTTON } from "./NoticeCard";
import { ClaudeMark, CodexMark, CopilotMark, DeepSeekMark, GreenferenceMark, GrokMark, KimiMark, KiroMark, ModelgoMark, type IconProps } from "./ProviderIcons";

export type AnnouncementButton = "primary" | "secondary";

const KIND_ICON: Record<AnnouncementKind, ComponentType<IconProps>> = { sponsor: Sparkles, product: Megaphone, tip: Lightbulb };
const MARK: Record<AnnouncementMark, ComponentType<IconProps>> = {
  claude: ClaudeMark, codex: CodexMark, grok: GrokMark, kimi: KimiMark, modelgo: ModelgoMark, greenference: GreenferenceMark,
  deepseek: DeepSeekMark, copilot: CopilotMark, kiro: KiroMark,
};

/** Each place is one the app already opens from its own menus; nothing here navigates the window anywhere. */
export function announcementPlaceAction(place: AnnouncementPlace): Action {
  switch (place) {
    case "api_keys": return openKeySettings();
    case "ai_engines": return { type: "toggleAppSettings", open: true, section: "engines" };
    case "connected_apps": return { type: "togglePlugins", open: true, surface: "apps" };
    case "new_bot": return { type: "newBot" };
    case "my_cloud": return { type: "toggleAppSettings", open: true, section: "cloudAccount" };
  }
}

const SECONDARY_LINK = "inline-flex items-center gap-1 py-2 text-[12px] text-ink-secondary hover:text-ink";

function Button({ label, action, primary, onDone, open }: {
  label: string; action: AnnouncementAction; primary: boolean; onDone: () => void; open: (place: AnnouncementPlace) => void;
}) {
  const className = primary ? cn(PRIMARY_BUTTON, "w-full") : SECONDARY_LINK;
  // An external page opens the way every notice's link does: the system browser on the desktop, a new tab with no
  // opener or referrer in a browser. The address is the file's, with nothing added.
  if ("open_url" in action) return <LinkButton url={action.open_url} label={label} className={className} onOpened={onDone} />;
  return <button type="button" className={className} onClick={() => { onDone(); open(action.open); }}>{label}</button>;
}

/** A card from the announcements file, drawn as every corner notice is. Its words are plain text: nothing in the file is
 * read as markup. A picture is a file in the repository's announcements/ folder, fetched with no cookie or referrer and
 * held to the card's width and 120 pixels high; one that fails to load leaves the card without it. */
export function AnnouncementCard({ card, onDone, open, locale = activeLocale() }: {
  card: Card;
  onDone: (action: "primary" | "secondary" | "close") => void;
  open: (place: AnnouncementPlace) => void;
  locale?: string;
}) {
  const [pictureFailed, setPictureFailed] = useState(false);
  const say = (text: Card["title"]) => localized(text, locale);
  const image = card.image;
  const Icon = image && "mark" in image ? MARK[image.mark] : KIND_ICON[card.kind];
  const titleId = `announcement-${card.id}-title`;
  return <NoticeCard titleId={titleId} notice="announcement" icon={Icon} title={say(card.title)} onDismiss={() => onDone("close")}>
    {card.label && <p data-announcement-label className="mt-1 text-[11px] font-medium uppercase leading-4 tracking-wide text-ink-tertiary">{say(card.label)}</p>}
    {image && "url" in image && !pictureFailed && <img src={image.url} alt={image.alt ? say(image.alt) : ""} loading="lazy" decoding="async"
      referrerPolicy="no-referrer" crossOrigin="anonymous" draggable={false} onError={() => setPictureFailed(true)}
      className="mt-2 block h-auto max-h-[120px] w-full rounded-lg object-cover" />}
    <p className="mt-1 whitespace-pre-line break-words text-[13px] leading-[18px] text-ink-secondary">{say(card.body)}</p>
    <div className="mt-3 flex flex-col gap-2">
      <Button label={say(card.primary.label)} action={card.primary.action} primary onDone={() => onDone("primary")} open={open} />
      {card.secondary
        ? <Button label={say(card.secondary.label)} action={card.secondary.action} primary={false} onDone={() => onDone("secondary")} open={open} />
        : <NotNowButton onClick={() => onDone("close")} />}
    </div>
  </NoticeCard>;
}
