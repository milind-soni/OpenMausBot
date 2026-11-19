import { File, FileArchive, FileCode2, FileImage, FilePenLine, FileText, FileVideo, Folder, FolderOpen } from "lucide-react";
import { cn } from "@/lib/cn";
import { detectPreviewFileKind, type PreviewFileKind } from "@/lib/mobilePreviewUrl";

const fileIcons = {
  html: { Icon: FileCode2, color: "text-amber-400" },
  pdf: { Icon: FileText, color: "text-rose-400" },
  markdown: { Icon: FileText, color: "text-violet-400" },
  text: { Icon: FileText, color: "text-ink-secondary" },
  image: { Icon: FileImage, color: "text-emerald-400" },
  video: { Icon: FileVideo, color: "text-sky-400" },
  archive: { Icon: FileArchive, color: "text-orange-400" },
  design: { Icon: FilePenLine, color: "text-violet-400" },
  other: { Icon: File, color: "text-ink-secondary" },
};

function kindFromName(name: string): keyof typeof fileIcons {
  const previewKind = detectPreviewFileKind(name);
  if (previewKind) return previewKind;
  if (/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(name)) return "video";
  if (/\.(zip|7z|rar|tar|gz)$/i.test(name)) return "archive";
  if (/\.(af|afdesign|afphoto|afpub)$/i.test(name)) return "design";
  return "other";
}

type ProjectFileIconProps =
  | { kind: "folder"; open?: boolean }
  | { kind: PreviewFileKind }
  | { name: string };

export function ProjectFileIcon(props: ProjectFileIconProps) {
  const size = "size-3.5 shrink-0";
  if ("kind" in props && props.kind === "folder") {
    const Icon = props.open ? FolderOpen : Folder;
    return <Icon aria-hidden="true" className={cn(size, props.open ? "text-accent" : "text-accent/80")} />;
  }

  const { Icon, color } = fileIcons["name" in props ? kindFromName(props.name) : props.kind];
  return <Icon aria-hidden="true" className={cn(size, color)} />;
}
