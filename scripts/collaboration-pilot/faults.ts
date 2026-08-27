export type PilotFaultAction =
  | { kind: "pass" }
  | { kind: "return"; value: unknown }
  | { kind: "throw"; code: string };

export interface PilotFaultObservation<Point extends string> {
  sequence: number;
  point: Point;
  action: PilotFaultAction;
}

/** A FIFO fault script: each hit consumes exactly one action for its point. */
export class DeterministicPilotFaults<Point extends string = string> {
  readonly observations: PilotFaultObservation<Point>[] = [];
  readonly calls = new Map<Point, number>();
  private readonly scripts = new Map<Point, PilotFaultAction[]>();
  private sequence = 0;

  constructor(script: Partial<Record<Point, readonly PilotFaultAction[]>> = {}) {
    for (const [point, actions] of Object.entries(script) as Array<[Point, readonly PilotFaultAction[] | undefined]>) {
      this.scripts.set(point, actions?.map((action) => ({ ...action })) ?? []);
    }
  }

  hit(point: Point): unknown {
    this.sequence += 1;
    this.calls.set(point, (this.calls.get(point) ?? 0) + 1);
    const action = this.scripts.get(point)?.shift() ?? { kind: "pass" as const };
    this.observations.push({ sequence: this.sequence, point, action: { ...action } });
    if (action.kind === "throw") throw new Error(action.code);
    return action.kind === "return" ? action.value : undefined;
  }

  remaining(point: Point): number {
    return this.scripts.get(point)?.length ?? 0;
  }

  append(point: Point, ...actions: PilotFaultAction[]): void {
    const existing = this.scripts.get(point) ?? [];
    existing.push(...actions.map((action) => ({ ...action })));
    this.scripts.set(point, existing);
  }
}
