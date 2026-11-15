import { afterEach, describe, expect, it, vi } from "vitest";

import { ROUTINE_RUN_LIMIT_MINUTES, SCHEDULER_STOP_WAIT_MS, busyWait, runLimitAt, runOverLimit, withBoundedStops } from "./routine-bounds.ts";
import { ROUTINE_BUSY_WAIT_MS } from "./routine-recovery.ts";
import { activeMs, resumeWork, workedMs } from "./routine-waits.ts";
import type { RoutineManagerOptions, RoutineRun } from "./routines.ts";

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const run = (more: Partial<RoutineRun> = {}): RoutineRun => ({
  id: "run", routineId: "r", routineName: "Check", target: "bot", botId: "bot-1", runOn: "maus", scheduledFor: 0, status: "running", manual: false, createdAt: 0, startedAt: 0, ...more,
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("the work a run has done", () => {
  it("is its time in status running since it last started: waits of any kind are left out", () => {
    const row = run();
    expect(workedMs(row, 2 * HOUR)).toBe(2 * HOUR);
    Object.assign(row, { status: "waiting", waitingSince: 2 * HOUR });
    expect(workedMs(row, 9 * HOUR)).toBe(2 * HOUR);
    resumeWork(row, 9 * HOUR);
    expect(row).toMatchObject({ status: "running", restedMs: 7 * HOUR });
    expect(workedMs(row, 9 * HOUR + 30 * MINUTE)).toBe(2 * HOUR + 30 * MINUTE);
  });

  it("starts again from a later start, so time queued for a retry or a usage limit's reset is not in it", () => {
    expect(workedMs(run({ createdAt: 0, startedAt: 5 * HOUR }), 6 * HOUR)).toBe(HOUR);
    expect(workedMs(run({ status: "queued", startedAt: undefined }), 6 * HOUR)).toBe(0);
  });

  it("counts a wait on work handed on toward a routine's own limit, as before, and never an open request", () => {
    expect(activeMs(run({ status: "waiting", waitingSince: HOUR }), 3 * HOUR)).toBe(3 * HOUR);
    expect(activeMs(run({ status: "waiting", waitingSince: HOUR, asked: { approval: true, subject: "to run it", since: HOUR } }), 3 * HOUR)).toBe(HOUR);
  });
});

describe("the run limit", () => {
  const limit = ROUTINE_RUN_LIMIT_MINUTES * MINUTE;

  it("stops a run with no limit of its own once it has worked three hours", () => {
    expect(ROUTINE_RUN_LIMIT_MINUTES).toBe(180);
    expect(runOverLimit(run(), limit - 1)).toBeNull();
    expect(runOverLimit(run(), limit)).toEqual({ text: "Stopped: this run ran longer than the 3-hour limit", codes: { errorCode: "routines.server.overLimit", errorParams: { hours: 3 } } });
    expect(runLimitAt(run(), HOUR)).toBe(limit);
  });

  it("never stops a run while it waits, and gives it the rest of its three hours when it goes on", () => {
    const waiting = run({ status: "waiting", waitingSince: HOUR });
    expect(runOverLimit(waiting, 30 * HOUR)).toBeNull();
    expect(runLimitAt(waiting, 30 * HOUR)).toBeNull();
    resumeWork(waiting, 30 * HOUR);
    expect(runOverLimit(waiting, 32 * HOUR - 1)).toBeNull();
    expect(runLimitAt(waiting, 31 * HOUR)).toBe(32 * HOUR);
    expect(runOverLimit(waiting, 32 * HOUR)?.text).toBe("Stopped: this run ran longer than the 3-hour limit");
  });

  it("leaves a queued or finished run alone", () => {
    for (const status of ["queued", "completed", "failed", "missed", "cancelled"] as const) {
      expect(runOverLimit(run({ status }), 30 * HOUR)).toBeNull();
      expect(runLimitAt(run({ status }), 30 * HOUR)).toBeNull();
    }
    expect(runOverLimit(run({ startedAt: undefined }), 30 * HOUR)).toBeNull();
  });

  it("keeps a routine's own limit, in its own words, counted as it always was", () => {
    const own = run({ timeoutMinutes: 10 });
    expect(runOverLimit(own, 10 * MINUTE - 1)).toBeNull();
    expect(runOverLimit(own, 10 * MINUTE)).toEqual({ text: "Stopped after reaching the 10-minute run limit", codes: { errorCode: undefined, errorParams: undefined } });
    const handedOn = run({ timeoutMinutes: 10, status: "waiting", waitingSince: MINUTE });
    expect(runOverLimit(handedOn, 10 * MINUTE)?.text).toBe("Stopped after reaching the 10-minute run limit");
    expect(runLimitAt(handedOn, 5 * MINUTE)).toBe(10 * MINUTE);
    const asked = run({ timeoutMinutes: 10, status: "waiting", waitingSince: MINUTE, asked: { approval: false, subject: "Which?", since: MINUTE } });
    expect(runOverLimit(asked, 5 * HOUR)).toBeNull();
    expect(runLimitAt(asked, 5 * HOUR)).toBeNull();
  });
});

describe("a queued run behind its busy bot", () => {
  it("is given up after an hour of that wait, with the reason", () => {
    const row = run({ status: "queued", startedAt: undefined });
    expect(busyWait(row, false, 1_000)).toEqual({ changed: true, missed: null });
    expect(row.busySince).toBe(1_000);
    expect(busyWait(row, false, 1_000 + ROUTINE_BUSY_WAIT_MS - 1)).toEqual({ changed: false, missed: null });
    expect(busyWait(row, undefined, 1_000 + ROUTINE_BUSY_WAIT_MS).missed).toEqual({ text: "Did not run: the bot was busy for more than 60 minutes",
      codes: { errorCode: "routines.server.busyTooLong", errorParams: { minutes: 60 } } });
  });

  it("does not time the wait behind its own routine's earlier run, and times a later busy bot from then", () => {
    const row = run({ status: "queued", startedAt: undefined });
    busyWait(row, false, 0);
    expect(busyWait(row, true, 2 * HOUR)).toEqual({ changed: true, missed: null });
    expect(row).not.toHaveProperty("busySince");
    expect(busyWait(row, true, 3 * HOUR)).toEqual({ changed: false, missed: null });
    expect(busyWait(row, false, 4 * HOUR)).toEqual({ changed: true, missed: null });
    expect(busyWait(row, false, 5 * HOUR).missed).not.toBeNull();
  });

  it("waits as long as it takes when it carries checked items", () => {
    const row = run({ status: "queued", startedAt: undefined, checkKey: "items-1" });
    busyWait(row, false, 0);
    expect(busyWait(row, false, 30 * HOUR).missed).toBeNull();
  });
});

describe("stopping a turn from the scheduler", () => {
  const base = { botState: () => "ready" as const, createTask: () => null, startTurn: async () => {} } satisfies RoutineManagerOptions;

  it("goes on after ten seconds when the engine never answers, and counts it", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const slow = { count: 0 };
    const options = withBoundedStops({ ...base, interruptTurn: () => new Promise<void>(() => {}), interruptGoal: () => new Promise<void>(() => {}) }, slow);
    let done = 0;
    void options.interruptTurn!("bot-1", "thread-1").then(() => { done += 1; });
    void options.interruptGoal!("room-1", "thread-2", { status: "stopped", detail: "x" }).then(() => { done += 1; });
    await vi.advanceTimersByTimeAsync(SCHEDULER_STOP_WAIT_MS - 1);
    expect([done, slow.count]).toEqual([0, 0]);
    await vi.advanceTimersByTimeAsync(1);
    expect([done, slow.count]).toEqual([2, 2]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns as soon as the stop does, passes a failure on, and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const slow = { count: 0 };
    const stops: string[] = [];
    const source: RoutineManagerOptions = { ...base, interruptTurn: async (_botId, threadId) => { stops.push(threadId); if (threadId === "bad") throw new Error("gone"); } };
    const options = withBoundedStops(source, slow);
    await options.interruptTurn!("bot-1", "thread-1");
    await expect(options.interruptTurn!("bot-1", "bad")).rejects.toThrow("gone");
    expect([stops, slow.count, vi.getTimerCount()]).toEqual([["thread-1", "bad"], 0, 0]);
  });

  it("stays a live view of the options: one set later is used, and one never set stays unset", async () => {
    const source: RoutineManagerOptions = { ...base };
    const options = withBoundedStops(source, { count: 0 });
    expect(options.interruptTurn).toBeUndefined();
    expect(options.botState("bot-1")).toBe("ready");
    const stops: string[] = [];
    source.interruptTurn = async (_botId, threadId) => { stops.push(threadId); };
    source.pausedText = () => "paused";
    await options.interruptTurn!("bot-1", "thread-9");
    expect([stops, options.pausedText?.("bot-1")]).toEqual([["thread-9"], "paused"]);
  });
});
