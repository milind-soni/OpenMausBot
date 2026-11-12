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
  expected?: string | null,
): Promise<{ ok: boolean; pending?: true; missing?: true }> {
  const own = await ownCloudComputer(cfg, botId, owners);
  // `expected` is the computer the person was asked about: one made since then is not theirs to lose.
  if (expected !== undefined && own && own.boxId !== expected) {
    throw Object.assign(new Error("a different cloud desktop runs now than when this was asked, so nothing was reset"), { status: 409 });
  }
  if (!own) return { ok: true, missing: true };
  return boat.deleteManagedBoat(cfg, owners, own.boxId, own.name, claim);
}

/** The bot's own cloud computer now, if it has one; throws when the list cannot be read. */
export async function ownCloudComputer(cfg: AppConfig, botId: string, owners: boat.ManagedBoatOwner[]) {
  const inventory = await boat.listManagedBoats(cfg, owners);
  if (!inventory.available) throw boat.inventoryFailure(inventory);
  return inventory.instances.find((instance) => instance.ownerBotId === botId);
}
