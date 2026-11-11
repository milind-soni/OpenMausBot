// Where speech input may send audio and ask for a model list from a Cloud home. A Cloud home sits beside other
// machines and a metadata service, so the address an admin types in Speech input may not reach a link-local or
// metadata address, and plain http goes only to the Cloud machine itself. Desktops and self-hosted servers keep
// any address: a Whisper server on the home network is what they are for.
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { Agent } from "undici";

import { addressClass } from "../electron/egress-addresses.mjs";
import { cloudHomeConfigured } from "./cloud-home.ts";
import { LOOPBACK_HOST } from "./stt-config.ts";

export class SttAddressRefused extends Error {}

export const STT_CLOUD_HTTP_ERROR = "On the Cloud, speech input needs an https:// address, or a server on the Cloud itself.";
export const STT_CLOUD_LINK_LOCAL_ERROR = "On the Cloud, speech input can't use a link-local or cloud metadata address.";

const NONE = new BlockList();
const refusedAddress = (address: string) => ["link-local", "metadata"].includes(addressClass(address, NONE));

/** Why a Cloud home refuses this API root before any connection, or null. A name is checked again when it is resolved. */
export function sttCloudRefusal(root: string, cloud = cloudHomeConfigured()): string | null {
  if (!cloud) return null;
  const url = URL.parse(root);
  if (!url) return null;
  if (url.protocol === "http:" && !LOOPBACK_HOST.test(url.hostname)) return STT_CLOUD_HTTP_ERROR;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return isIP(host) && refusedAddress(host) ? STT_CLOUD_LINK_LOCAL_ERROR : null;
}

type Resolve = (host: string, callback: (error: Error | null, addresses: LookupAddress[]) => void) => void;
const resolveAll: Resolve = (host, callback) => dnsLookup(host, { all: true, verbatim: true }, callback);

/** A socket lookup that refuses a name if any address it resolves to is link-local or metadata, at every connection,
 * so a name that later points at the metadata service is refused too. */
export function refusingLookup(resolve: Resolve = resolveAll) {
  return (host: string, options: { all?: boolean }, callback: (error: Error | null, address?: string | LookupAddress[], family?: number) => void) => {
    resolve(host, (error, addresses) => {
      if (error) return callback(error);
      if (!addresses.length || addresses.some((entry) => refusedAddress(entry.address))) return callback(new SttAddressRefused(STT_CLOUD_LINK_LOCAL_ERROR));
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

let cloudAgent: Agent | undefined;

/** The fetch speech input uses: the global one on a desktop or self-hosted server, and on a Cloud home one whose
 * connections go through `refusingLookup`. Its FormData goes with it, as each fetch accepts only its own. */
export async function sttHttp(cloud = cloudHomeConfigured()): Promise<{ fetch: typeof fetch; FormData: typeof FormData; dispatcher?: Agent }> {
  if (!cloud) return { fetch: globalThis.fetch, FormData: globalThis.FormData };
  const undici = await import("undici");
  cloudAgent ??= new undici.Agent({ connect: { lookup: refusingLookup() } as never });
  return { fetch: undici.fetch as unknown as typeof fetch, FormData: undici.FormData as unknown as typeof FormData, dispatcher: cloudAgent };
}

/** The refusal behind a failed fetch, which wraps a socket error in `cause` (or an AggregateError's `errors`). */
export function sttRefusalIn(error: unknown, depth = 0): SttAddressRefused | null {
  if (error instanceof SttAddressRefused) return error;
  if (!(error instanceof Error) || depth > 4) return null;
  for (const inner of [error.cause, ...(error instanceof AggregateError ? error.errors : [])]) {
    const found = sttRefusalIn(inner, depth + 1);
    if (found) return found;
  }
  return null;
}
