import { createRoot } from "react-dom/client";
import { DreamMemoryCard } from "../components/bot-settings/DreamMemoryCard";
import "../styles.css";
import { setLocale } from "../lib/i18n";
setLocale("en");

const botId = new URLSearchParams(location.search).get("bot")!;
const root = createRoot(document.getElementById("root")!);
root.render(<main className="max-w-xl p-6"><DreamMemoryCard botId={botId} enabled onChange={async () => {}} /></main>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
