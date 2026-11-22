import { KeyRound, Server } from "lucide-react";
import { t } from "@/lib/i18n";

export const COMPOSIO_SIGN_UP_URL = "https://dashboard.composio.dev";

/** What to do on the Apps page when this app has no Composio project key: three steps and one action. */
export function ComposioKeySteps({ onPasteKey }: { onPasteKey: () => void }) {
  return (
    <section data-apps-key-steps aria-labelledby="apps-key-steps-title" className="mb-4 rounded-xl bg-control/50 px-4 py-3 text-[13px] leading-5 text-ink-secondary">
      <h3 id="apps-key-steps-title" className="text-[14px] font-medium leading-5 text-ink">{t("connectors.setupNeeded")}</h3>
      <ol className="mt-2 list-decimal space-y-1 ps-5">
        <li>
          {t("connectors.setup.step1")}{" "}
          <a href={COMPOSIO_SIGN_UP_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-accent-text underline underline-offset-2">
            {t("connectors.setup.openComposio")}
          </a>
        </li>
        <li>{t("connectors.setup.step2")}</li>
        <li>{t("connectors.setup.step3")}</li>
      </ol>
      <button type="button" data-apps-paste-key onClick={onPasteKey} className="ui-button ui-button-md ui-button-pill ui-button-primary mt-3">
        <KeyRound size={16} aria-hidden="true" />
        {t("connectors.setup.pasteKey")}
      </button>
    </section>
  );
}

/** The Connected view with nothing in it and no Composio key: both ways to add something. */
export function ConnectedEmptyWithoutKey({ onPasteKey, onAddMcp }: { onPasteKey: () => void; onAddMcp: () => void }) {
  return (
    <div data-apps-connected-empty="no-key" className="flex min-h-40 flex-col items-center justify-center text-center">
      <div className="text-[14px] font-medium text-ink">{t("connectors.empty.noneTitle")}</div>
      <div className="mt-1 text-[13px] text-ink-secondary">{t("connectors.empty.noKeyDesc")}</div>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <button type="button" onClick={onPasteKey} className="ui-button ui-button-md ui-button-pill ui-button-primary">
          <KeyRound size={16} aria-hidden="true" />
          {t("connectors.setup.pasteKey")}
        </button>
        <button type="button" onClick={onAddMcp} className="ui-button ui-button-md ui-button-pill">
          <Server size={16} aria-hidden="true" />
          {t("connectors.empty.addMcp")}
        </button>
      </div>
    </div>
  );
}
