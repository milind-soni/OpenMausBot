import { useEffect, useId } from "react";
import { KeyRound } from "lucide-react";

import { liveDisclosure, liveKeyCopy } from "@/lib/call-mode";
import { dismissLiveNotice } from "@/lib/live-call-media";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { openKeySettings } from "./keys/key-focus";
import { LiveKeySetup } from "./LiveKeySetup";
import { LiveProviderSettings } from "./LiveProviderSettings";

export function LiveKeyNeeded() {
  const { state, dispatch } = useStore();
  const titleId = useId();
  const live = state.config?.live;
  const azure = live?.provider === "azure";
  const fish = live?.provider === "fish";
  const copy = liveKeyCopy(live?.provider);
  // A key is tied to the endpoint it is saved for, so the endpoint comes first.
  const keyForm = ((azure && Boolean(live?.azureEndpoint)) || fish) && live?.keySource !== "live";
  return <section aria-labelledby={titleId} className="flex flex-col gap-2.5 rounded-xl border border-hairline bg-panel p-4 text-left text-[13px]">
    <div className="flex items-start gap-2.5">
      <KeyRound size={16} className="mt-0.5 shrink-0 text-ink-secondary" aria-hidden="true" />
      <h2 id={titleId} className="text-[14px] font-medium leading-[1.4] text-ink">{t(copy.needs)}</h2>
    </div>
    <LiveProviderSettings />
    {(azure || fish) && <DismissWhenReady ready={live?.configured === true} />}
    {keyForm && <LiveKeySetup compact onSaved={() => {}} />}
    {!azure && !fish && <button type="button" className="ui-button ui-button-primary self-start" onClick={() => { dismissLiveNotice(); dispatch(openKeySettings("openai", "liveCalls")); }}>{t("call.live.openApiKeys")}</button>}
    <p className="text-[12px] leading-[1.45] text-ink-tertiary">{!keyForm && `${liveDisclosure({ cloudHome: state.config?.cloudHome === true, azure, fish })} `}{t(copy.cost)}</p>
  </section>;
}

function DismissWhenReady({ ready }: { ready: boolean }) {
  useEffect(() => {
    if (ready) dismissLiveNotice();
  }, [ready]);
  return null;
}
