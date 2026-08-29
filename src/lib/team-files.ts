import { api } from "@/state/store";

interface ExportedPlaybook {
  name: string;
  members: number;
  markdown: string;
}

function downloadPlaybook(playbook: ExportedPlaybook): { name: string; members: number } {
  const slug =
    playbook.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "botmrr-team";
  const blob = new Blob([playbook.markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slug}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { name: playbook.name, members: playbook.members };
}

/** Export every active sidebar agent as one portable team Markdown package. */
export async function downloadAllBots(): Promise<{ name: string; members: number }> {
  const playbook = (await api("/api/teams/export", {
    method: "POST",
    body: JSON.stringify({ format: "package" }),
  })) as ExportedPlaybook;
  return downloadPlaybook(playbook);
}
