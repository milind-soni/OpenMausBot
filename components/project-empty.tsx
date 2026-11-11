import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** Shared empty state of a project tab: icon, short title, at most one action. Kept out of the library so the Code tab does not load it. */
export function ProjectEmpty({ icon: Icon, title, spin, children }: { icon: LucideIcon; title: string; spin?: boolean; children?: ReactNode }) {
  return <div className="project-empty"><span className="project-empty-icon" aria-hidden="true"><Icon size={20} className={spin ? "spin" : undefined} /></span><h2>{title}</h2>{children}</div>;
}
