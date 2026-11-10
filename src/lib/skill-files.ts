import type { PackageDocument } from "../../shared/package-format";

export type SharedSkillFile = { skill: string; path: string; binary: boolean; executable: boolean; content?: string };

export function sharedSkillFiles(document: PackageDocument): SharedSkillFile[] {
  return (document.package.skills?.entries ?? []).flatMap((skill) => (skill.files ?? []).map((file) => ({
    skill: skill.name, path: file.path, binary: "binary" in file,
    executable: ("executable" in file && file.executable === true) || /\.(?:sh|bash|zsh|fish|ps1|psm1|bat|cmd|py|rb|pl|php|lua|js|mjs|cjs|ts)$/i.test(file.path),
    ...( "content" in file ? { content: file.content } : {} ),
  })));
}
