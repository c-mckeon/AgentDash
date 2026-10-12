/** The run lifecycle. Pure rules, no I/O. */

export const STATUSES = [
  "queued",
  "triaging",
  "running",
  "reviewing",
  "done",
  "failed",
  "killed",
  "budget_stopped",
] as const;

export type RunStatus = (typeof STATUSES)[number];

const HAPPY_PATH: Partial<Record<RunStatus, RunStatus>> = {
  queued: "triaging",
  triaging: "running",
  running: "reviewing",
  reviewing: "done",
};

/** Ways a run can end early, from any state that is still in progress. */
const EARLY_ENDS: RunStatus[] = ["failed", "killed", "budget_stopped"];

export function isTerminal(status: RunStatus): boolean {
  return !(status in HAPPY_PATH);
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  if (isTerminal(from)) return false;
  return HAPPY_PATH[from] === to || EARLY_ENDS.includes(to);
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) throw new Error(`A run cannot go from ${from} to ${to}`);
}
