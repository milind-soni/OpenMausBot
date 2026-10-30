// What a person can do to an automation, the same from the page, its panel and the chat card.
import { useState } from "react";

import type { Automation } from "@/lib/automations";
import { copyText } from "@/lib/copy-text";
import type { RoutineRun } from "@/lib/routines";
import { useShowThreads } from "@/lib/thread-preferences";
import { loadWebhookCredentials, removeWebhookCredential, saveWebhookCredential, webhookCredentialStore } from "@/lib/webhook-credentials";
import type { WebhookCredential } from "@/lib/webhooks";
import { api, openBotThread, useStore } from "@/state/store";

export function useAutomationActions() {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  /** What the error is about, e.g. "toggle:<id>", so it shows beside the thing that was clicked. */
  const [errorFor, setErrorFor] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const attempt = async (key: string, work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    setError("");
    setErrorFor(null);
    try { await work(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); setErrorFor(key); }
    finally { setBusy(null); }
  };

  const toggle = (automation: Automation) => attempt(`toggle:${automation.id}`, async () => {
    if (automation.kind === "schedule") {
      const response = await api(`/api/routines/${automation.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !automation.enabled }) });
      dispatch({ type: "routinePatched", routine: response.routine });
      return;
    }
    const response = await api(`/api/webhooks/${automation.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !automation.enabled, verificationPending: false }) });
    dispatch({ type: "webhookPatched", webhook: response.webhook });
  });

  const runNow = (automation: Automation) => attempt(`run:${automation.id}`, () => automation.kind === "schedule"
    ? new Promise<void>((resolve, reject) => dispatch({ type: "runRoutine", routineId: automation.id, onStarted: () => resolve(), onError: reject }))
    : api(`/api/webhooks/${automation.id}/test`, { method: "POST", body: JSON.stringify({ event: "openmaus.test", message: "A test run from Automations" }) }));

  /** Asks once (a person deleting their own automation), then deletes it. */
  const remove = async (automation: Automation, question: string): Promise<boolean> => {
    if (!window.confirm(question)) return false;
    if (automation.kind === "schedule") {
      dispatch({ type: "deleteRoutine", routineId: automation.id });
      return true;
    }
    await attempt(`delete:${automation.id}`, async () => {
      await api(`/api/webhooks/${automation.id}`, { method: "DELETE" });
      dispatch({ type: "webhookDeleted", webhookId: automation.id });
      removeWebhookCredential(webhookCredentialStore(), automation.id);
    });
    return true;
  };

  /** The address another app sends to, as the server keeps it: the owning bot may already have given it to an app, so
   * copying never replaces it. Only one from before addresses were kept, and not copied here before, gets a new one. */
  const copyAddress = (webhookId: string, replace = false) => attempt(`copy:${webhookId}`, async () => {
    let credential: WebhookCredential | undefined;
    if (!replace) {
      credential = await api(`/api/webhooks/${webhookId}/address`).then((response) => response.credential as WebhookCredential, () => undefined)
        ?? loadWebhookCredentials(webhookCredentialStore())[webhookId];
      if (credential) saveWebhookCredential(webhookCredentialStore(), webhookId, credential);
    }
    if (!credential) {
      const response = await api(`/api/webhooks/${webhookId}/rotate`, { method: "POST" });
      credential = response.credential as WebhookCredential;
      dispatch({ type: "webhookPatched", webhook: response.webhook });
      saveWebhookCredential(webhookCredentialStore(), webhookId, credential);
    }
    if (await copyText(credential.url) !== "copied") throw new Error("Couldn't copy the address");
    setCopied(webhookId);
    setTimeout(() => setCopied((current) => (current === webhookId ? null : current)), 1_800);
  });

  const openRun = (automation: Automation, run: RoutineRun | undefined) => {
    const bot = state.bots.find((candidate) => candidate.id === automation.botId);
    if (bot && run?.threadId) openBotThread(dispatch, bot, run.threadId, showThreads);
  };

  return { busy, error, errorFor, setError, copied, toggle, runNow, remove, copyAddress, openRun };
}
