// What the Team files routes answer (server/routes/team-files.ts) and the page reads (src/components/team-files).
export type TeamFileAction = "uploaded" | "added" | "changed" | "deleted" | "renamed" | "folder";

/** The last change of a file or of anything in a folder, by name: the person who did it, or for whom the bot did it. */
export interface TeamFileChangeView { at: number; action: TeamFileAction; person?: string; bot?: string; from?: string }

export interface TeamFileView {
  name: string;
  /** Relative to the team's folder, "/"-separated. */
  path: string;
  kind: "file" | "folder";
  size: number;
  modifiedAt: number;
  last?: TeamFileChangeView;
  /** The viewer may delete or rename it: an admin anything, a member what they uploaded. */
  canDelete: boolean;
  mine: boolean;
}

export interface TeamFilesListing {
  path: string;
  entries: TeamFileView[];
  used: number;
  cap: number;
  uploadMax: number;
  admin: boolean;
}

/** Why a request was refused, as the routes' `code`. */
export type TeamFilesRefusal = "bad_path" | "not_found" | "exists" | "forbidden" | "too_large" | "full" | "link" | "not_file" | "not_folder" | "incomplete" | "bad_length";
