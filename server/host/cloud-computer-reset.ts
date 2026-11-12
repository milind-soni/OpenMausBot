import * as boat from "../boat.ts";
import type { AppConfig } from "../config.ts";

/**
 * Deletes a bot's own cloud computer the way Settings → Cloud computers does, so one stuck
 * starting can be replaced: the bot's next turn makes a fresh one. A missing computer is
 * already reset. deleteManagedBoat refuses while the bot works, and `claim` holds the
 * bot's lifecycle lane, so a turn cannot start on the computer being deleted.
 */
export async function resetBotCloudComputer(
  cfg: AppConfig,
  botId: string,
  owners: boat.ManagedBoatOwner[],
  claim: boat.ManagedBoatMutationClaim,
): Promise<{ ok: boolean; pending?: true; missing?: true }> {
  const inventory = await boat.listManagedBoats(cfg, owners);
  if (!inventory.available) throw boat.inventoryFailure(inventory);
  const own = inventory.instances.find((instance) => instance.ownerBotId === botId);
  if (!own) return { ok: true, missing: true };
  return boat.deleteManagedBoat(cfg, owners, own.boxId, own.name, claim);
}
