/** A named, workspace-owned Box. Assignment grants one team's Auto bots
 * access to the same desktop, files and desktop browser sessions. */
export interface TeamComputer {
  id: string;
  name: string;
  section: string | null;
  state: string;
  held: boolean;
  problem?: string;
}

export interface TeamComputersPayload {
  computers: TeamComputer[];
  configured: boolean;
  problem?: string;
}
