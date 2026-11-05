import { createRoot } from "react-dom/client";
import { TelegramCard } from "../../src/components/bot-settings/TelegramCard";
import { StoreProvider, type Bot } from "../../src/state/store";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { applySkin, readSkin } from "../../src/lib/skins";
import "../../src/styles.css";

// Only scripts/verify-telegram.ts serves this entry: the real per-bot Telegram card for the bot named in the query.
setAnalyticsEnabled(false);
applySkin(readSkin());
const params = new URLSearchParams(window.location.search);
const bot = { id: params.get("bot") ?? "", name: params.get("name") ?? "Scout" } as Bot;
createRoot(document.getElementById("root")!).render(
  <StoreProvider><main className="mx-auto max-w-xl p-8"><TelegramCard bot={bot} /></main></StoreProvider>,
);
