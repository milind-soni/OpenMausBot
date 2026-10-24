import { createRoot } from "react-dom/client";
import { ChiefJobCancel } from "../../src/components/ChiefJobCancel";
import "../../src/styles.css";
const params = new URLSearchParams(location.search);
createRoot(document.getElementById("root")!).render(<ChiefJobCancel botId={params.get("bot")!} threadId={params.get("thread")!} busy={false} waiting={false} />);
