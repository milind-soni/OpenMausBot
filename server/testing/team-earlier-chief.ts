import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { CloudTeamFixture } from "../../scripts/testing/cloud-send-fixture.ts";

/** A person's own Chief from before their MausBot became it: a crown no route gives a bot someone owns any more, reached
 * by handing them the team's own Chief before their first look at the bots makes their MausBot. */
export async function chiefCrownedEarlier<T>(team: CloudTeamFixture, token: string, name: string, email: string): Promise<T> {
  const bots = JSON.parse(readFileSync(join(team.home, ".openmausbot", "bots.json"), "utf8")) as Array<{ id: string; chiefOfStaff?: boolean }>;
  const chief = bots.find((bot) => bot.chiefOfStaff)!;
  const renamed = await team.as(token, "PATCH", `/api/bots/${chief.id}`, { name });
  if (renamed.status !== 200) throw new Error(`rename: ${JSON.stringify(renamed.body)}`);
  const handed = await team.as(token, "PUT", `/api/bots/${chief.id}/reports-to`, { email });
  if (handed.status !== 200) throw new Error(`hand over: ${JSON.stringify(handed.body)}`);
  return handed.body.bot as T;
}
