import type { InstanceInfo, ModelSelection } from "@/state/store";
import { modelArrangement } from "@/lib/model-arrangement";
import { t } from "@/lib/i18n";

export function ModelArrangementCard({ instance, selection, endpointUrl, changing = false }: {
  instance?: InstanceInfo;
  selection: ModelSelection;
  endpointUrl?: string;
  changing?: boolean;
}) {
  const arrangement = modelArrangement(instance, selection, endpointUrl);
  const supported = [
    instance?.capabilities?.agentsMcp || instance?.capabilities?.composioMcp ? t("model.arrangement.mcp") : null,
    instance?.capabilities?.browserMcp ? t("model.arrangement.browser") : null,
    instance?.capabilities?.computerMcp || instance?.capabilities?.localComputerMcp ? t("model.arrangement.computer") : null,
  ].filter((item): item is string => item !== null);
  const locationDetail = t(`model.arrangement.${arrangement.location}Detail`);
  return (
    <div data-model-arrangement data-agent-kind={arrangement.direct ? "openmausbot" : "connected"}
      data-inference-location={arrangement.location} data-model-known={Boolean(arrangement.model)}
      className="min-w-0 rounded-xl border border-hairline/50 bg-inset/50 p-3 text-[12px] leading-relaxed text-ink-secondary">
      <p className="text-[13px] font-semibold text-ink">
        {t(arrangement.direct ? "model.arrangement.directRuns" : "model.arrangement.agentRuns", { agent: arrangement.agent })}
      </p>
      <p className="mt-1 break-words text-ink">
        {arrangement.model ? t("model.arrangement.usingModel", { model: arrangement.model }) : t("model.arrangement.unknownModel")}
      </p>
      {!arrangement.model && <p>{t("model.arrangement.modelSetIn", { place: arrangement.modelControlledBy })}</p>}
      {arrangement.route ? (
        <p className="mt-1 break-words">
          {t(arrangement.direct ? "model.arrangement.directSource" : "model.arrangement.runtimeSource", {
            route: arrangement.route, agent: arrangement.agent,
          })}
        </p>
      ) : !arrangement.direct && <p className="mt-1">{t("model.arrangement.unknownRuntimeRoute", { agent: arrangement.agent })}</p>}
      {(arrangement.location !== "unknown" || arrangement.route) && <p className="mt-1">{locationDetail}</p>}
      <details className="mt-2 border-t border-hairline/40 pt-2">
        <summary className="cursor-pointer font-medium text-ink">{t("model.arrangement.details")}</summary>
        <div className="mt-2 space-y-1.5 leading-relaxed">
          <p>{t(arrangement.direct ? "model.arrangement.directBehavior" : "model.arrangement.runtimeBehavior", { agent: arrangement.agent })}</p>
          <p>{t(arrangement.direct ? "model.arrangement.directConfig" : "model.arrangement.runtimeConfig", { agent: arrangement.agent })}</p>
          {supported.length > 0 && <p>{t("model.arrangement.supported", { features: supported.join(", ") })}</p>}
          <p>{t(arrangement.direct ? "model.arrangement.directPermission" : "model.arrangement.runtimePermission", { agent: arrangement.agent })}</p>
        </div>
      </details>
      {changing && <p data-model-switch-note className="mt-2 border-t border-hairline/40 pt-2 leading-relaxed">
        {t("model.arrangement.switchNote")}
      </p>}
    </div>
  );
}
