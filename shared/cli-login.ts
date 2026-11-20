/** Where `openmausbot login` asks and polls; Allow and Deny are under it. */
export const CLI_LOGIN_PATH = "/api/auth/cli-login";

/** A terminal's `openmausbot login` waiting for the owner or an admin, as their window shows it: never its poll secret or a token. */
export interface CliLoginWire {
  id: string;
  /** Shown in the terminal too, so the person allows the terminal they are looking at. */
  code: string;
  label: string;
  scopes: Array<"admin" | "client">;
  /** Asked from this computer rather than over the network. */
  local: boolean;
  source: string;
  createdAt: number;
  expiresAt: number;
}
