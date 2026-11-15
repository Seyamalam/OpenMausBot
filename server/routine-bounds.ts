// Nothing a bot does on its own holds a routine's schedule up without end: a started run stops after a limit of work, a
// run queued behind its busy bot is given up after an hour, and stopping a turn never keeps the scheduler from its
// other routines. Each ends with its reason on the run's row.
import { codedLine, fittedLine, type RoutineLine } from "./routine-lines.ts";
import { ROUTINE_BUSY_WAIT_MS } from "./routine-recovery.ts";
import { activeMs, workedMs } from "./routine-waits.ts";
import type { RoutineManagerOptions, RoutineRun } from "./routines.ts";

/** Work (routine-waits.ts `workedMs`) a run may do when its routine sets no limit of its own (`timeoutMinutes`). */
export const ROUTINE_RUN_LIMIT_MINUTES = 180;
/** How long the scheduler waits for a turn to stop before it goes on to its other work. */
export const SCHEDULER_STOP_WAIT_MS = 10_000;

type Started = Pick<RoutineRun, "status" | "startedAt" | "timeoutMinutes" | "waitedMs" | "restedMs" | "asked" | "waitingSince">;

/** How much of its limit a started run has left; null for a run no limit applies to now. A routine's own limit counts
 * as it always has (`activeMs`: only an open approval or question is taken out); the default one counts work only
 * (`workedMs`), and never ends a run while it waits. */
function limitLeft(run: Started, now: number): number | null {
  if (run.startedAt == null || (run.status !== "running" && run.status !== "waiting")) return null;
  if (run.timeoutMinutes != null) return run.timeoutMinutes * 60_000 - activeMs(run, now);
  return run.status === "waiting" ? null : ROUTINE_RUN_LIMIT_MINUTES * 60_000 - workedMs(run, now);
}

/** When a started run reaches its limit if it goes on as it is; null while it cannot (no limit applies, or a request
 * of its own is open, which its limit does not count). */
export function runLimitAt(run: Started, now: number): number | null {
  const left = limitLeft(run, now);
  return left === null || run.asked ? null : now + Math.max(0, left);
}

/** Why a started run must stop now; null while it is within its limit. */
export function runOverLimit(run: Started, now: number): RoutineLine | null {
  const left = limitLeft(run, now);
  if (left === null || left > 0) return null;
  return run.timeoutMinutes != null ? fittedLine("error", `Stopped after reaching the ${run.timeoutMinutes}-minute run limit`, undefined)
    : codedLine("error", "routines.server.overLimit", { hours: ROUTINE_RUN_LIMIT_MINUTES / 60 });
}

/** A queued run that cannot start because its bot is busy with other work: `busySince` times that wait, and the line is
 * why it is given up once the wait has lasted ROUTINE_BUSY_WAIT_MS. Waiting behind its own routine's earlier run is not
 * this wait: that run has bounds of its own. A run of checked items waits as long as it takes. */
export function busyWait(run: RoutineRun, behindOwnRoutine: boolean | undefined, now: number): { changed: boolean; missed: RoutineLine | null } {
  if (behindOwnRoutine) {
    const changed = run.busySince !== undefined;
    delete run.busySince;
    return { changed, missed: null };
  }
  const changed = run.busySince === undefined;
  run.busySince ??= now;
  const over = run.checkKey === undefined && now - run.busySince >= ROUTINE_BUSY_WAIT_MS;
  return { changed, missed: over ? codedLine("error", "routines.server.busyTooLong", { minutes: ROUTINE_BUSY_WAIT_MS / 60_000 }) : null };
}

/** How often stopping a turn did not finish in time, since this process started. */
export interface SlowStops { count: number }

async function within(work: Promise<void>, slow: SlowStops): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), SCHEDULER_STOP_WAIT_MS); timer.unref?.(); });
  try {
    if (await Promise.race([work, late]) !== "late") return;
    slow.count += 1;
    work.catch(() => {});
    console.warn(`routines: stopping a turn did not finish in ${SCHEDULER_STOP_WAIT_MS / 1000} s; the scheduler went on without it`);
  } finally {
    clearTimeout(timer);
  }
}

/** A live view of the same options in which each stop of a turn or goal is given SCHEDULER_STOP_WAIT_MS: an engine that
 * never answers its interrupt is counted in `slow` and left behind, while the stop itself keeps going. */
export function withBoundedStops(options: RoutineManagerOptions, slow: SlowStops): RoutineManagerOptions {
  return Object.create(options, {
    interruptTurn: { get: () => options.interruptTurn && (async (botId: string, threadId: string) => within(options.interruptTurn!(botId, threadId), slow)) },
    interruptGoal: { get: () => options.interruptGoal && (async (groupId: string | undefined, threadId: string, outcome?: { status: "stopped" | "limit-reached"; detail: string }) =>
      within(options.interruptGoal!(groupId, threadId, outcome), slow)) },
  }) as RoutineManagerOptions;
}
