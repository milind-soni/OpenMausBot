import { useRef, useState } from "react";
import { api, useStore, type ConfigStatus, type ModelSelection } from "@/state/store";
import { t } from "@/lib/i18n";
import { approvalReviewEffortLevels, defaultApprovalReviewEffort, DEFAULT_APPROVAL_REVIEW_SETTINGS, MAX_APPROVAL_REVIEW_INSTRUCTIONS_LENGTH, type ApprovalReviewSettings as ReviewSettings } from "../../shared/approval-review";
import { APPROVAL_REVIEW_RUBRIC } from "../../shared/approval-review-policy";
import { Card } from "./SettingsPrimitives";
import { effortLabel } from "./ModelPicker";

const SELECT_CLASS = "mt-2 w-full min-w-0 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink disabled:opacity-50";

export function ApprovalReviewSettings() {
  const { state, dispatch } = useStore();
  const [draft, setDraft] = useState<ReviewSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const value = draft ?? state.config?.approvalReview ?? DEFAULT_APPROVAL_REVIEW_SETTINGS;
  const engines = state.instances.filter((instance) => instance.capabilities?.approvalReview === true && instance.snapshot.state === "available" && !instance.policy);
  const engine = engines.find((instance) => instance.instanceId === value.model?.instanceId);
  const models = engine?.models.options.filter((model) => engine.snapshot.authenticated !== false || model.custom) ?? [];
  const model = models.find((model) => model.id === value.model?.model);
  const variants = engine?.capabilities?.modelVariants ? model?.variants ?? [] : [];
  const levels = approvalReviewEffortLevels(engine?.capabilities ?? {});
  const defaultEffort = defaultApprovalReviewEffort(engine?.capabilities ?? {});
  const effortReady = value.model?.effort === undefined || levels.includes(value.model.effort);
  const ready = !value.model || Boolean(model && effortReady);
  const change = (next: ReviewSettings) => { setDraft(next); setError(""); };
  const chooseModel = (selection?: ModelSelection) => change({ ...value, model: selection });
  const save = async () => {
    if (!draft || inFlight.current || !ready || !state.config) return;
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const config = await api<ConfigStatus>("/api/config", {
        method: "PUT",
        body: JSON.stringify({ approvalReview: { model: draft.model ?? null, instructions: draft.instructions ?? "" } }),
      });
      dispatch({ type: "configStatus", config });
      setDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.approvalReview.error"));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  return (
    <Card title={t("settings.section.approvalReview")}>
      <p className="text-[13px] leading-relaxed text-ink-secondary">{t("settings.approvalReview.hierarchy")}</p>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("settings.approvalReview.scope")}</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="min-w-0">
          <label htmlFor="approval-review-engine" className="block text-[13px] font-medium text-ink">{t("settings.approvalReview.engine")}</label>
          <select id="approval-review-engine" value={value.model?.instanceId ?? ""} disabled={saving || !state.config}
            onChange={(event) => chooseModel(event.target.value ? { instanceId: event.target.value, model: "" } : undefined)} className={SELECT_CLASS}>
            <option value="">{t("settings.approvalReview.session")}</option>
            {value.model && !engine && <option value={value.model.instanceId} disabled>{t("settings.approvalReview.unavailable", { name: value.model.instanceId })}</option>}
            {engines.map((instance) => <option key={instance.instanceId} value={instance.instanceId}
              disabled={!instance.models.options.some((model) => instance.snapshot.authenticated !== false || model.custom)}>{instance.displayName}</option>)}
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor="approval-review-model" className="block text-[13px] font-medium text-ink">{t("settings.approvalReview.model")}</label>
          <select id="approval-review-model" value={value.model?.model ?? ""} disabled={saving || !engine}
            onChange={(event) => chooseModel({ instanceId: engine!.instanceId, model: event.target.value })} className={SELECT_CLASS}>
            <option value="">{t("settings.approvalReview.chooseModel")}</option>
            {value.model?.model && !model && <option value={value.model.model} disabled>{t("settings.approvalReview.unavailable", { name: value.model.model })}</option>}
            {models.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </div>
      </div>
      {value.model && (levels.length > 0 || value.model.effort !== undefined) && <div className="mt-3">
        <label htmlFor="approval-review-effort" className="text-[13px] font-medium text-ink">{t("settings.approvalReview.effort")}</label>
        <select id="approval-review-effort" value={value.model.effort ?? ""} disabled={saving || !model} className={SELECT_CLASS}
          onChange={(event) => { const { effort: _effort, variant: _variant, ...selection } = value.model!; chooseModel({ ...selection, ...(event.target.value ? { effort: event.target.value as ModelSelection["effort"] } : {}) }); }}>
          <option value="">{defaultEffort ? t("settings.approvalReview.defaultEffort", { effort: effortLabel(defaultEffort) }) : t("settings.approvalReview.providerDefault")}</option>
          {value.model.effort && !levels.includes(value.model.effort) && <option value={value.model.effort} disabled>{value.model.effort}</option>}
          {levels.map((level) => <option key={level} value={level}>{effortLabel(level)}</option>)}
        </select>
      </div>}
      {value.model && (engine?.capabilities?.modelVariants || value.model.variant !== undefined) && <div className="mt-3">
        <label htmlFor="approval-review-variant" className="text-[13px] font-medium text-ink">{t("settings.approvalReview.variant")}</label>
        <select id="approval-review-variant" value={value.model.variant ?? ""} disabled={saving || !model} className={SELECT_CLASS}
          onChange={(event) => { const { effort: _effort, variant: _variant, ...selection } = value.model!; chooseModel({ ...selection, ...(event.target.value ? { variant: event.target.value } : {}) }); }}>
          <option value="">{t("settings.approvalReview.providerDefault")}</option>
          {value.model.variant && !variants.some((variant) => variant.id === value.model?.variant) && <option value={value.model.variant} disabled>{value.model.variant}</option>}
          {variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.label}</option>)}
        </select>
      </div>}
      <p role="status" className="mt-2 text-[12px] text-ink-secondary">{value.model && !model ? t("settings.approvalReview.required") : !effortReady ? t("settings.approvalReview.unsupportedEffort") : value.model ? t("settings.approvalReview.selectedStatus") : t("settings.approvalReview.sessionStatus")}</p>
      <button type="button" onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "engines" })}
        className="mt-2 text-[12px] text-accent underline underline-offset-2">{t("settings.approvalReview.manageModels")}</button>
      <details className="mt-4 rounded-lg border border-hairline/40 bg-inset">
        <summary className="cursor-pointer px-3 py-2 text-[13px] font-medium text-ink">{t("settings.approvalReview.builtInRules")}</summary>
        <div className="border-t border-hairline/40 px-3 py-3">
          <p id="approval-review-rubric-help" className="text-[12px] leading-relaxed text-ink-secondary">{t("settings.approvalReview.builtInRulesHelp")}</p>
          <pre aria-label={t("settings.approvalReview.builtInRules")} aria-describedby="approval-review-rubric-help"
            className="mt-3 max-h-80 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink-secondary">{APPROVAL_REVIEW_RUBRIC}</pre>
        </div>
      </details>
      <div className="mt-4">
        <label htmlFor="approval-review-instructions" className="text-[13px] font-medium text-ink">{t("settings.approvalReview.instructions")}</label>
        <p id="approval-review-instructions-help" className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("settings.approvalReview.instructionsHelp")}</p>
        <textarea id="approval-review-instructions" aria-describedby="approval-review-instructions-help" value={value.instructions ?? ""}
          maxLength={MAX_APPROVAL_REVIEW_INSTRUCTIONS_LENGTH} rows={5} disabled={saving || !state.config}
          onChange={(event) => change({ ...value, instructions: event.target.value })}
          className="mt-2 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink disabled:opacity-50" />
      </div>
      <button type="button" disabled={!draft || saving || !ready || !state.config} onClick={() => void save()}
        className="mt-3 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white disabled:opacity-50">{saving ? t("settings.threads.saving") : t("common.save")}</button>
      {saving && <span role="status" className="sr-only">{t("settings.threads.saving")}</span>}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </Card>
  );
}
