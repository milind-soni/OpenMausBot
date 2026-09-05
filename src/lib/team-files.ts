import { api } from "@/state/store";
import { parseTeamBackup } from "../../shared/team-backup";

/** Private portable backup; shareable Markdown remains a separate API format. */
export async function downloadAllBots(): Promise<{ name: string; members: number; warnings: string[] }> {
  const backup = parseTeamBackup(await api("/api/teams/export", {
    method: "POST",
    body: JSON.stringify({ format: "backup" }),
  }));
  const slug =
    backup.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "openmaus";
  const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slug}-${new Date(backup.exportedAt).toISOString().slice(0, 10)}.mausbackup.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { name: backup.name, members: backup.bots.length, warnings: backup.warnings };
}
