import type { RoutineSchedule } from "@/lib/routines";

export interface BotOverview {
  who: { name: string; title: string; blurb: string; soulLead: string };
  does: string[];
  doesRoutines?: OverviewRoutineLine[];
  managedSections?: string[];
  reaches: string[];
  wont: string[];
  recent: Array<{ at: number; summary: string }>;
  setup?: SetupStep[];
}

export interface SetupStep {
  id: "identity" | "soul" | "folder" | "apps" | "schedule";
  label: string;
  done: boolean;
  section?: "identity" | "soul" | "access" | "routines";
}

export interface OverviewRoutineLine {
  name: string;
  paused?: true;
  schedule: RoutineSchedule;
  nextRunAt?: number;
  lastRun?: { status: string; at: number };
}
