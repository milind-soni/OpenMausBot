import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import type { CatalogEntry } from "../../shared/connector-catalog";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { mcpSignInLink } from "@/lib/mcp-sign-in";
import { tagLabel } from "@/lib/science-catalog";
import { BotAccessDisclosure } from "./BotAccessDisclosure";
import { ServiceIcon } from "./ServiceIcon";
import { TILE_BUTTON_CLASS, TILE_CLASS } from "./app-tile";

export type TileState = "idle" | "working" | "browser" | "tenant" | "connected" | "locked";

export interface TileSignIn {
  authorizationUrl: string | null;
  pasteBack: boolean;
}

export interface ScienceTileProps {
  entry: CatalogEntry;
  state: TileState;
  needsMax: boolean;
  unavailable: boolean;
  showForm: boolean;
  signIn: TileSignIn | null;
  error: string | null;
  onConnect(): void;
  onSubmitAddress(address: string): void;
  onContinue(): void;
  onComplete(callbackUrl: string): Promise<void>;
  onTurnOff(): void;
}

const FIELD_CLASS = "h-8 w-full min-w-0 rounded-lg bg-inset px-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent/50";
const HELP_CLASS = "text-[12px] leading-relaxed text-ink-secondary";

function TenantForm({ busy, onSubmit }: { busy: boolean; onSubmit(address: string): void }) {
  const [address, setAddress] = useState("");
  return (
    <form className="mt-2 flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); onSubmit(address); }}>
      <input
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={address}
        disabled={busy}
        onChange={(event) => setAddress(event.target.value)}
        placeholder={t("science.tenantPlaceholder")}
        aria-label={t("science.tenantPlaceholder")}
        className={FIELD_CLASS}
      />
      <p className={HELP_CLASS}>{t("science.tenantHelp")}</p>
      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy} className={TILE_BUTTON_CLASS}>{t("connectors.action.connect")}</button>
      </div>
    </form>
  );
}

function PasteBack({ onComplete }: { onComplete(callbackUrl: string): Promise<void> }) {
  const [url, setUrl] = useState("");
  const [completing, setCompleting] = useState(false);
  const complete = async () => {
    setCompleting(true);
    try { await onComplete(url); } finally { setCompleting(false); }
  };
  return (
    <div className="mt-2 flex flex-col gap-2">
      <p className={HELP_CLASS}>{t("mcp.auth.pasteBackHint")}</p>
      <input
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={url}
        disabled={completing}
        onChange={(event) => setUrl(event.target.value)}
        aria-label={t("mcp.auth.callbackUrl")}
        placeholder={t("mcp.auth.callbackUrl")}
        className={FIELD_CLASS}
      />
      <div className="flex items-center gap-2">
        <button type="button" disabled={!url.trim() || completing} onClick={() => void complete()} className={TILE_BUTTON_CLASS}>{t("mcp.auth.complete")}</button>
      </div>
    </div>
  );
}

export function ScienceTile({ entry, state, needsMax, unavailable, showForm, signIn, error, onConnect, onSubmitAddress, onContinue, onComplete, onTurnOff }: ScienceTileProps) {
  const connected = state === "connected";
  const description = state === "browser" ? t("connectors.finishSetup") : needsMax ? t("science.needsMax") : entry.description;
  const link = mcpSignInLink(signIn?.authorizationUrl);
  const action = connected ? onTurnOff : state === "browser" ? onContinue : onConnect;
  const disabled = state === "working" || state === "locked" || (unavailable && !connected);
  return (
    <div data-app-tile={entry.id} className={TILE_CLASS}>
      <div className="flex items-center gap-3">
        <ServiceIcon card={{ logo: null, domain: entry.domain, label: entry.name }} className="size-10 shrink-0 rounded-[10px]" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold leading-5 text-ink" title={entry.name}>{entry.name}</span>
            {connected && <Check size={13} strokeWidth={2.5} className="shrink-0 text-success" aria-label={t("apps.connected")} />}
            <span className={cn("inline-flex h-[18px] shrink-0 items-center whitespace-nowrap rounded-full px-1.5 text-[11px] font-medium leading-[18px] bg-control/90 text-ink-secondary", entry.tag === "no-account" && "bg-success/15 text-success")}>
              {tagLabel(entry.tag)}
            </span>
          </div>
          <div className="truncate text-[12.5px] leading-[18px] text-ink-secondary" title={description}>{description}</div>
        </div>
        <button type="button" disabled={disabled} title={unavailable ? t("science.noAddress") : undefined} onClick={action} className={TILE_BUTTON_CLASS}>
          {state === "working" ? <Loader2 size={14} className="animate-spin" /> : connected ? t("mcp.turnOff") : state === "browser" ? t("connectors.action.continue") : t("connectors.action.connect")}
        </button>
      </div>
      <div className="ps-[52px]">
        {state === "browser" && link && (
          <a href={link} onClick={(event) => { event.preventDefault(); onContinue(); }} className="mt-1.5 inline-block text-[12px] text-accent-text underline underline-offset-2">
            {t("connectors.openAuthorizationPage")}
          </a>
        )}
        {state === "browser" && signIn?.pasteBack && <PasteBack onComplete={onComplete} />}
        {showForm && !connected && <TenantForm busy={state === "working"} onSubmit={onSubmitAddress} />}
        {error && <p role="alert" className="mt-1.5 text-[12px] text-danger">{error}</p>}
        {connected && <BotAccessDisclosure paragraphs={[t("science.accessHint", { name: entry.name })]} />}
      </div>
    </div>
  );
}
