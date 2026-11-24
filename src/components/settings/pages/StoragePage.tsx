import { useEffect, useMemo, useState } from "react";

import { settleSeen, storageBand, storageBotNames, storageFullness, storageScope } from "@/lib/storage-report";
import { measureStorage, rememberStorageSeen, useStorageReport, useStorageSeen } from "@/lib/use-storage-report";
import { useStoreSelector } from "@/state/store-select";
import { useTeamPeople } from "@/state/team-people";
import { StorageView } from "../StorageView";
import { useSettingsShell } from "../settings-shell";

/** Read again this often while a pass runs and the page is open. */
const WHILE_RUNNING_MS = 10_000;

export function StoragePage() {
  const { ctx } = useSettingsShell();
  const read = useStorageReport({ enabled: ctx.admin && !ctx.client, everyMs: WHILE_RUNNING_MS, whileRunning: true });
  const bots = useStoreSelector((state) => state.bots);
  const teamPeople = useTeamPeople();
  const me = teamPeople?.me?.email ?? null;
  const names = useMemo(() => storageBotNames(bots, ctx.team ? { me } : null), [bots, ctx.team, me]);
  const [measuring, setMeasuring] = useState(false);
  const [now, setNow] = useState(Date.now);
  const answer = read.status === "ready" ? read.answer : null;
  const scope = answer ? storageScope(answer) : null;
  const seen = useStorageSeen(scope);
  const percent = storageFullness(answer)?.percent ?? null;
  useEffect(() => { setNow(Date.now()); }, [answer]);
  // Opening Storage is seeing it: this Cloud's sidebar line for this band (or a lower one) stays away until usage falls well
  // under it.
  useEffect(() => {
    if (percent === null || scope === null) return;
    const band = storageBand(percent), settled = settleSeen(seen, percent);
    const next = band === "full" || settled === "full" ? "full" : band === "near" || settled === "near" ? "near" : null;
    if (next !== seen) rememberStorageSeen(scope, next);
  }, [percent, seen, scope]);
  const measure = () => {
    setMeasuring(true);
    void measureStorage().finally(() => setMeasuring(false));
  };
  return <StorageView answer={answer} fetchedAt={read.status === "ready" ? read.fetchedAt : now} now={now} nameOf={(id) => names.get(id)}
    team={ctx.team} measuring={measuring} onMeasure={measure} />;
}
