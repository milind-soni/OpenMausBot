import { FolderOpen } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ProjectRecord } from "@/types/gbs";

export function ProjectSuggestionList({
  projects,
  highlight,
  onHighlight,
  onPick,
  className,
}: {
  projects: ProjectRecord[];
  highlight: number;
  onHighlight(index: number): void;
  onPick(project: ProjectRecord): void;
  className?: string;
}) {
  return (
    <div
      role="listbox"
      aria-label="Reference a project"
      className={cn("z-20 w-80 max-w-[calc(100%-1rem)] overflow-hidden rounded-xl border border-hairline/40 bg-raised shadow-lg", className)}
    >
      {projects.map((project, index) => (
        <button
          key={project.id}
          type="button"
          role="option"
          aria-selected={index === highlight}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(project)}
          onMouseEnter={() => onHighlight(index)}
          className={cn(
            "flex w-full items-center gap-2.5 px-3 py-2 text-left",
            index === highlight && "bg-raised-hover",
          )}
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <FolderOpen size={15} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-ink">{project.name}</span>
            <span className="block truncate text-[11px] text-ink-secondary">{project.path}</span>
          </span>
          <span className="shrink-0 text-[12px] font-medium text-accent">#{project.mention}</span>
        </button>
      ))}
    </div>
  );
}
