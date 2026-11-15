// What a schedule may count on: failures never turn a routine off, nothing holds it up without end, every occurrence
// that does not run leaves a row, and a routines.json that cannot be read is kept, reported and read again.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SCHEDULER_STOP_WAIT_MS } from "./routine-bounds.ts";
import { UNREADABLE_RETRY_MS } from "./routine-file.ts";
import { RoutineManager, type RoutineManagerOptions, type RoutineRun } from "./routines.ts";

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const START = Date.parse("2026-11-16T08:00:00Z");
const NO_START = "Maus's cloud desktop didn't start. Change where this routine runs.";
const dirs: string[] = [];

function harness(start = START, file?: string) {
  let now = start, bot: "ready" | "busy" | "missing" = "ready", task = 0;
  if (!file) { const dir = mkdtempSync(join(tmpdir(), "omb-routine-reliability-")); dirs.push(dir); file = join(dir, "routines.json"); }
  const started: string[] = [], interrupted: string[] = [], emitted: Array<Record<string, unknown>> = [], changed: RoutineRun[] = [];
  const failed: Array<{ run: RoutineRun; alert: unknown }> = [], deferred: RoutineRun[] = [];
  const options: RoutineManagerOptions = {
    file, now: () => now, emit: (payload) => emitted.push(payload), botState: () => bot,
    createTask: () => ({ threadId: `thread-${++task}` }),
    startTurn: async (_botId, threadId) => { started.push(threadId); },
    interruptTurn: async (_botId, threadId) => { interrupted.push(threadId); },
    onRunChanged: (run) => changed.push(run), onRunFailed: (run, alert) => failed.push({ run, alert }), onRunDeferred: (run) => deferred.push(run),
  };
  const h = {
    file, options, started, interrupted, emitted, changed, failed, deferred, manager: new RoutineManager(options),
    at: (value: number) => { now = value; }, bot: (value: typeof bot) => { bot = value; },
    tickAt: async (value: number) => { now = value; await h.manager.tick(); },
    /** The process ends and another starts on the same file: the first one's scheduler does nothing more. */
    restart: () => { h.manager.close(); return (h.manager = new RoutineManager(options)); },
    event: (threadId: string, type: string, more: Record<string, unknown> = {}) =>
      h.manager.handleRuntimeEvent({ eventId: `${type}-${threadId}`, provider: "fake", threadId, createdAt: new Date(now).toISOString(), type, ...more } as Parameters<RoutineManager["handleRuntimeEvent"]>[0]),
    done: (threadId: string) => h.event(threadId, "turn.completed", { ok: true }),
    runs: () => h.manager.listRuns().sort((a, b) => a.createdAt - b.createdAt || a.scheduledFor - b.scheduledFor),
    routine: () => h.manager.listRoutines()[0]!,
    disk: () => JSON.parse(readFileSync(file!, "utf8")) as { routines: Array<Record<string, unknown>>; runs: RoutineRun[] },
  };
  return h;
}

const every = (minutes: number, more: Record<string, unknown> = {}) => ({ name: "Fix new bugs", prompt: "Look for new bug reports and fix them", botId: "maus-1",
  schedule: { type: "interval" as const, everyMinutes: minutes, anchorAt: START }, ...more });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a routine whose runs fail", () => {
  it("stays on through three cloud-computer start failures in a row, and runs its next occurrence once the computer works", async () => {
    const h = harness();
    h.manager.create(every(24 * 60));
    for (const day of [1, 2, 3]) {
      await h.tickAt(START + day * 24 * HOUR);
      h.manager.failThread(`thread-${day}`, NO_START, { cause: "refused" });
      expect(h.routine()).toMatchObject({ enabled: true, nextRunAt: START + (day + 1) * 24 * HOUR });
    }
    expect(h.routine()).toMatchObject({ enabled: true, failureStreak: 3, noStartStreak: 3 });
    expect(h.failed.map((failure) => failure.alert)).toEqual([undefined, null, { detail: expect.stringContaining("3 runs in a row failed this way. It stays on") }]);

    await h.tickAt(START + 4 * 24 * HOUR);
    expect(h.started).toEqual(["thread-1", "thread-2", "thread-3", "thread-4"]);
    h.done("thread-4");
    expect(h.runs().map((run) => run.status)).toEqual(["failed", "failed", "failed", "completed"]);
    expect(h.routine()).toMatchObject({ enabled: true, nextRunAt: START + 5 * 24 * HOUR });
    expect(h.routine()).not.toHaveProperty("noStartStreak");
    expect(h.restart().listRoutines()[0]).toMatchObject({ enabled: true, nextRunAt: START + 5 * 24 * HOUR });
  });

  it("spaces a frequent routine's tries instead of starting one every few minutes, on one row, and starts again by itself", async () => {
    const h = harness();
    h.manager.create(every(5));
    for (const turn of [1, 2, 3]) {
      await h.tickAt(START + turn * 5 * MINUTE);
      h.manager.failThread(`thread-${turn}`, NO_START, { cause: "refused" });
    }
    const failedAt = START + 15 * MINUTE;
    for (let minute = 20; minute <= 70; minute += 5) await h.tickAt(START + minute * MINUTE);
    expect(h.started).toHaveLength(3);
    expect(h.routine()).toMatchObject({ enabled: true, noStartStreak: 3, skippedRuns: 11 });
    const held = h.runs().filter((run) => run.skipped);
    expect(held).toMatchObject([{ status: "missed", error: "Skipped 11 scheduled runs because its cloud desktop has not started, so its next tries are spaced out",
      skipped: { count: 11, firstAt: START + 20 * MINUTE, lastAt: START + 70 * MINUTE }, seenAt: START + 20 * MINUTE }]);
    expect(h.failed).toHaveLength(3);

    await h.tickAt(failedAt + HOUR);
    expect(h.started).toHaveLength(4);
    h.manager.failThread("thread-4", NO_START, { cause: "refused" });
    await h.tickAt(failedAt + HOUR + 3 * HOUR + 55 * MINUTE);
    expect(h.started).toHaveLength(4);
    await h.tickAt(failedAt + HOUR + 4 * HOUR);
    expect(h.started).toHaveLength(5);
    h.done("thread-5");
    await h.tickAt(failedAt + HOUR + 4 * HOUR + 5 * MINUTE);
    expect(h.started).toHaveLength(6);
    expect(h.routine()).not.toHaveProperty("noStartStreak");
  });

  it("lets the person start a run by hand, or change the routine, while its tries are spaced out", async () => {
    const h = harness();
    const routine = h.manager.create(every(5));
    for (const turn of [1, 2, 3]) {
      await h.tickAt(START + turn * 5 * MINUTE);
      h.manager.failThread(`thread-${turn}`, NO_START, { cause: "refused" });
    }
    h.manager.runNow(routine.id); await h.tickAt(START + 16 * MINUTE);
    expect(h.started).toHaveLength(4);
    h.manager.failThread("thread-4", NO_START, { cause: "refused" });
    await h.tickAt(START + 20 * MINUTE);
    expect(h.started).toHaveLength(4);
    h.manager.update(routine.id, { prompt: "Look for new bug reports, fix them, and say what changed" });
    await h.tickAt(START + 25 * MINUTE);
    expect(h.started).toHaveLength(5);
  });

  it("counts failures in a row from the saved rows, so a restart between two failures hides neither", async () => {
    const h = harness();
    const routine = h.manager.create(every(60));
    await h.tickAt(START + HOUR);
    h.manager.failThread("thread-1", "The bot did not complete this run", { cause: "refused" });
    expect(h.manager.health(100)).toEqual([{ routineId: routine.id, status: "failed", at: START + HOUR, consecutiveFailures: 1 }]);
    h.restart();
    expect(h.manager.health(100)).toEqual([{ routineId: routine.id, status: "failed", at: START + HOUR, consecutiveFailures: 1 }]);
    await h.tickAt(START + 2 * HOUR);
    h.manager.failThread("thread-2", "The bot did not complete this run", { cause: "refused" });
    h.restart();
    expect(h.manager.health(100)).toEqual([{ routineId: routine.id, status: "failed", at: START + 2 * HOUR, consecutiveFailures: 2 }]);
    expect(h.routine().failureStreak).toBe(2);
    await h.tickAt(START + 3 * HOUR);
    h.done("thread-3");
    expect(h.manager.health(100)).toEqual([{ routineId: routine.id, status: "completed", at: START + 3 * HOUR, consecutiveFailures: 0 }]);
  });
});

describe("routines an earlier version turned off after three cloud-computer start failures", () => {
  const saved = (id: string, more: Record<string, unknown> = {}) => ({ id, ...every(60), target: "bot", runOn: "maus", durationMinutes: 30, enabled: false, nextRunAt: null, createdAt: START, updatedAt: START + 3 * HOUR + 50, ...more });
  const failures = (routineId: string) => [1, 2, 3].map((hour): RoutineRun => ({ id: `${routineId}-${hour}`, routineId, routineName: "Fix new bugs", target: "bot", botId: "maus-1", runOn: "maus",
    scheduledFor: START + hour * HOUR, status: "failed", manual: false, error: NO_START, createdAt: START + hour * HOUR, startedAt: START + hour * HOUR, finishedAt: START + hour * HOUR + 50 }));

  it("come back on at the next start, and only those: one a person paused, one changed since and one held stay as they are", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-routine-reliability-")); dirs.push(dir);
    const file = join(dir, "routines.json");
    const routines = [saved("switched-off"), saved("paused-by-person", { updatedAt: START + 5 * HOUR }), saved("renamed-since", { name: "Renamed", updatedAt: START + 4 * HOUR }),
      saved("held", { heldFor: "no_connections" }), saved("on", { enabled: true, nextRunAt: START + 9 * HOUR })];
    writeFileSync(file, JSON.stringify({ version: 1, routines, runs: routines.flatMap((routine) => failures(routine.id)) }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness(START + 7 * HOUR + 10 * MINUTE, file);
    const after = Object.fromEntries(h.manager.listRoutines().map((routine) => [routine.id, routine]));
    expect(after["switched-off"]).toMatchObject({ enabled: true, nextRunAt: START + 8 * HOUR, updatedAt: START + 7 * HOUR + 10 * MINUTE });
    expect(after["switched-off"]).not.toHaveProperty("noStartStreak");
    expect(after["paused-by-person"]).toMatchObject({ enabled: false, nextRunAt: null, updatedAt: START + 5 * HOUR });
    expect(after["renamed-since"]).toMatchObject({ enabled: false, nextRunAt: null, updatedAt: START + 4 * HOUR });
    expect(after.held).toMatchObject({ enabled: false, heldFor: "no_connections", updatedAt: START + 3 * HOUR + 50 });
    expect(after.on).toMatchObject({ enabled: true, nextRunAt: START + 9 * HOUR });
    expect(warn.mock.calls.flat().join(" ")).toContain("turned 1 back on");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("Fix new bugs");
  });

  it("run their next occurrence, stay on across another start, and stay off once the person turns them off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-routine-reliability-")); dirs.push(dir);
    const file = join(dir, "routines.json");
    writeFileSync(file, JSON.stringify({ version: 1, routines: [saved("switched-off")], runs: failures("switched-off") }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness(START + 7 * HOUR + 10 * MINUTE, file);
    await h.tickAt(START + 8 * HOUR);
    expect(h.started).toEqual(["thread-1"]);
    h.done("thread-1");
    expect(h.disk().routines[0]).toMatchObject({ enabled: true });
    h.manager.update("switched-off", { enabled: false });
    expect(h.restart().listRoutines()[0]).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it("wait under the cause that holds every routine, and come back when it ends", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-routine-reliability-")); dirs.push(dir);
    const file = join(dir, "routines.json");
    writeFileSync(file, JSON.stringify({ version: 1, routines: [saved("switched-off")], runs: failures("switched-off"), holds: ["no_connections"] }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness(START + 7 * HOUR + 10 * MINUTE, file);
    expect(h.routine()).toMatchObject({ enabled: false, heldFor: "no_connections" });
    h.manager.holdFor([]);
    expect(h.routine()).toMatchObject({ enabled: true, nextRunAt: START + 8 * HOUR });
    expect(h.routine()).not.toHaveProperty("heldFor");
  });
});

describe("deliberate pauses still hold", () => {
  it("keeps a routine the person paused off, and one held because its owner left off until the cause ends", async () => {
    const h = harness();
    const paused = h.manager.create(every(60, { name: "Paused by hand" }));
    const held = h.manager.create(every(60, { name: "Held" }));
    h.manager.update(paused.id, { enabled: false });
    expect(h.manager.holdFor(["no_connections"])).toEqual(["no_connections"]);
    await h.tickAt(START + 2 * HOUR);
    expect(h.started).toEqual([]);
    const after = h.restart().listRoutines();
    expect(after.find((routine) => routine.id === paused.id)).toMatchObject({ enabled: false });
    expect(after.find((routine) => routine.id === paused.id)).not.toHaveProperty("heldFor");
    expect(after.find((routine) => routine.id === held.id)).toMatchObject({ enabled: false, heldFor: "no_connections" });
    h.manager.holdFor([]);
    expect(h.manager.listRoutines().map((routine) => [routine.name, routine.enabled]).sort()).toEqual([["Held", true], ["Paused by hand", false]]);
  });

  it("lets a bot the person paused drop its scheduled runs quietly", async () => {
    const h = harness();
    h.options.pausedText = () => "Maus is paused, so it takes no new work."; h.options.held = () => true;
    h.manager.create(every(60));
    await h.tickAt(START + HOUR);
    expect(h.runs().map((run) => [run.status, run.error])).toEqual([["cancelled", "Maus is paused, so it takes no new work."]]);
    expect([h.started, h.failed]).toEqual([[], []]);
    expect(h.routine().enabled).toBe(true);
  });
});

describe("a run queued behind a busy bot", () => {
  it("ends as missed after an hour, with the reason, and the schedule carries on", async () => {
    const h = harness(); h.bot("busy");
    h.manager.create(every(120));
    const due = START + 2 * HOUR;
    await h.tickAt(due);
    await h.tickAt(due + 59 * MINUTE);
    expect(h.runs()).toMatchObject([{ status: "queued", deferredAt: due, busySince: due }]);
    expect(h.deferred).toHaveLength(1);
    await h.tickAt(due + HOUR);
    expect(h.runs()).toMatchObject([{ status: "missed", finishedAt: due + HOUR, error: "Did not run: the bot was busy for more than 60 minutes",
      errorCode: "routines.server.busyTooLong", errorParams: { minutes: 60 } }]);
    expect(h.failed.map((failure) => [failure.run.status, failure.alert])).toEqual([["missed", undefined]]);
    expect(h.routine()).toMatchObject({ enabled: true, nextRunAt: START + 4 * HOUR });

    h.bot("ready");
    await h.tickAt(START + 4 * HOUR);
    expect(h.started).toEqual(["thread-1"]);
    expect(h.runs().map((run) => run.status)).toEqual(["missed", "running"]);
  });

  it("keeps the hour across a restart", async () => {
    const h = harness(); h.bot("busy");
    h.manager.create(every(120));
    const due = START + 2 * HOUR;
    await h.tickAt(due);
    h.at(due + 30 * MINUTE); h.restart();
    expect(h.runs()).toMatchObject([{ status: "queued", busySince: due }]);
    await h.tickAt(due + HOUR);
    expect(h.runs()).toMatchObject([{ status: "missed" }]);
  });

  it("does not give up a run queued behind its own routine's earlier run", async () => {
    const h = harness();
    h.manager.create(every(30, { overlap: "queue" }));
    await h.tickAt(START + 30 * MINUTE);
    await h.tickAt(START + 60 * MINUTE);
    await h.tickAt(START + 150 * MINUTE);
    expect(h.runs().filter((run) => !run.skipped).map((run) => run.status)).toEqual(["running", "queued"]);
    h.done("thread-1");
    await h.tickAt(START + 151 * MINUTE);
    expect(h.started).toEqual(["thread-1", "thread-2"]);
  });
});

describe("occurrences that land while an earlier run of the routine is going", () => {
  it("leave one missed row for the whole run, with their count and first and last time, and are shown as already seen", async () => {
    const h = harness();
    h.manager.create(every(5));
    await h.tickAt(START + 5 * MINUTE);
    for (let minute = 10; minute <= 170; minute += 5) await h.tickAt(START + minute * MINUTE);
    const [running, skipped, ...rest] = h.runs();
    expect(rest).toEqual([]);
    expect(running).toMatchObject({ status: "running", threadId: "thread-1" });
    expect(skipped).toMatchObject({ status: "missed", scheduledFor: START + 10 * MINUTE, finishedAt: START + 170 * MINUTE, seenAt: START + 10 * MINUTE,
      error: "Skipped 33 scheduled runs because the previous run of this routine is still running",
      skipped: { count: 33, firstAt: START + 10 * MINUTE, lastAt: START + 170 * MINUTE, behind: running!.id } });
    expect(h.failed).toEqual([]);
    expect(h.changed.filter((run) => run.id === skipped!.id)).toEqual([]);
    expect(h.emitted.filter((frame) => frame.kind === "routine.run" && (frame.run as RoutineRun).id === skipped!.id)).toHaveLength(33);
    expect(h.routine()).toMatchObject({ skippedRuns: 33, lastSkippedAt: START + 170 * MINUTE });
    expect(h.disk().runs.find((run) => run.id === skipped!.id)?.skipped).toMatchObject({ count: 33 });

    h.done("thread-1");
    await h.tickAt(START + 175 * MINUTE);
    await h.tickAt(START + 180 * MINUTE);
    expect(h.runs().map((run) => [run.status, run.skipped?.count])).toEqual([["completed", undefined], ["missed", 33], ["running", undefined], ["missed", 1]]);
  });

  it("keeps the count across a restart", async () => {
    const h = harness();
    h.options.hasPendingDelegations = () => true;
    h.manager.create(every(5));
    await h.tickAt(START + 5 * MINUTE);
    h.done("thread-1");
    await h.tickAt(START + 10 * MINUTE);
    h.restart();
    await h.tickAt(START + 15 * MINUTE);
    expect(h.runs().filter((run) => run.skipped)).toMatchObject([{ skipped: { count: 2, firstAt: START + 10 * MINUTE, lastAt: START + 15 * MINUTE } }]);
  });
});

describe("the default run limit", () => {
  it("stops a run after three hours of work, fails it with the reason, and starts the next occurrence", async () => {
    const h = harness();
    h.manager.create(every(240));
    const due = START + 4 * HOUR;
    await h.tickAt(due);
    await h.tickAt(due + 3 * HOUR - 1);
    expect(h.runs()).toMatchObject([{ status: "running" }]);
    await h.tickAt(due + 3 * HOUR);
    expect(h.runs()).toMatchObject([{ status: "failed", finishedAt: due + 3 * HOUR, error: "Stopped: this run ran longer than the 3-hour limit", errorCode: "routines.server.overLimit", errorParams: { hours: 3 } }]);
    expect(h.interrupted).toEqual(["thread-1"]);
    expect(h.failed.map((failure) => failure.run.error)).toEqual(["Stopped: this run ran longer than the 3-hour limit"]);
    expect(h.routine()).toMatchObject({ enabled: true, nextRunAt: START + 8 * HOUR });
    expect(h.event("thread-1", "turn.completed", { ok: false, stopReason: "interrupted" })).toBeNull();
    await h.tickAt(START + 8 * HOUR);
    expect(h.started).toEqual(["thread-1", "thread-2"]);
    expect(h.runs().map((run) => run.status)).toEqual(["failed", "running"]);
  });

  it("does not count the time an approval or question is open, nor a wait on work handed on", async () => {
    const h = harness();
    let handedOn = false;
    h.options.hasPendingDelegations = () => handedOn;
    h.manager.create({ ...every(60), schedule: { type: "once", at: START + HOUR } });
    const due = START + HOUR;
    await h.tickAt(due);
    h.at(due + HOUR); h.event("thread-1", "request.opened", { requestType: "question", tool: "ask", summary: "Which repository?" });
    await h.tickAt(due + 11 * HOUR);
    expect(h.runs()).toMatchObject([{ status: "waiting" }]);
    h.event("thread-1", "request.resolved", { behavior: "answer", source: "user" });
    expect(h.runs()).toMatchObject([{ status: "running", restedMs: 10 * HOUR }]);
    await h.tickAt(due + 12 * HOUR);
    handedOn = true; h.done("thread-1");
    expect(h.runs()).toMatchObject([{ status: "waiting", waitingSince: due + 12 * HOUR }]);
    await h.tickAt(due + 40 * HOUR);
    expect(h.runs()).toMatchObject([{ status: "waiting" }]);
    h.event("thread-1", "turn.started");
    await h.tickAt(due + 41 * HOUR - 1);
    expect(h.runs()).toMatchObject([{ status: "running", restedMs: 38 * HOUR }]);
    await h.tickAt(due + 41 * HOUR);
    expect(h.runs()).toMatchObject([{ status: "failed", error: "Stopped: this run ran longer than the 3-hour limit" }]);
  });

  it("does not count the time a run is queued: behind a busy bot, or for the one retry after a failure", async () => {
    const h = harness(); h.bot("busy");
    h.manager.create({ ...every(60), schedule: { type: "once", at: START + HOUR } });
    await h.tickAt(START + HOUR);
    h.bot("ready");
    await h.tickAt(START + HOUR + 50 * MINUTE);
    expect(h.runs()).toMatchObject([{ status: "running", startedAt: START + HOUR + 50 * MINUTE }]);
    h.at(START + 3 * HOUR);
    h.event("thread-1", "runtime.error", { message: "The AI service is overloaded (529)" });
    h.event("thread-1", "turn.completed", { ok: false, stopReason: "error" });
    expect(h.runs()).toMatchObject([{ status: "queued", retried: "provider" }]);
    await h.tickAt(START + 3 * HOUR + MINUTE);
    expect(h.runs()).toMatchObject([{ status: "running", startedAt: START + 3 * HOUR + MINUTE }]);
    await h.tickAt(START + 6 * HOUR);
    expect(h.runs()).toMatchObject([{ status: "running" }]);
    await h.tickAt(START + 6 * HOUR + MINUTE);
    expect(h.runs()).toMatchObject([{ status: "failed" }]);
  });

  it("gives way to a routine's own limit, and reaches a run started by hand", async () => {
    const h = harness();
    const own = h.manager.create(every(240, { name: "Own limit", timeoutMinutes: 30 }));
    await h.tickAt(START + 4 * HOUR);
    await h.tickAt(START + 4 * HOUR + 30 * MINUTE);
    expect(h.runs()).toMatchObject([{ status: "failed", error: "Stopped after reaching the 30-minute run limit" }]);
    h.manager.update(own.id, { enabled: false, timeoutMinutes: null });
    h.manager.runNow(own.id); await h.tickAt(START + 5 * HOUR);
    await h.tickAt(START + 8 * HOUR);
    expect(h.runs().at(-1)).toMatchObject({ manual: true, status: "failed", error: "Stopped: this run ran longer than the 3-hour limit" });
  });

  it("wakes the scheduler when a run reaches it, with no other work due", async () => {
    vi.useFakeTimers({ now: START });
    const h = harness();
    h.options.now = () => Date.now();
    h.restart();
    h.manager.create({ ...every(60), schedule: { type: "once", at: START + MINUTE } });
    h.manager.start();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(h.runs()).toMatchObject([{ status: "running" }]);
    await vi.advanceTimersByTimeAsync(3 * HOUR - MINUTE);
    expect(h.runs()).toMatchObject([{ status: "running" }]);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(h.runs()).toMatchObject([{ status: "failed", error: "Stopped: this run ran longer than the 3-hour limit" }]);
    h.manager.stop();
  });
});

describe("a turn that does not stop", () => {
  it("holds the scheduler ten seconds, then the other routines fire", async () => {
    vi.useFakeTimers({ now: START });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    h.options.now = () => Date.now();
    h.options.interruptTurn = () => new Promise<void>(() => {});
    h.restart();
    h.manager.create(every(240, { name: "Runs too long", timeoutMinutes: 30 }));
    h.manager.create(every(270, { name: "Must still fire", botId: "maus-2" }));
    vi.setSystemTime(START + 4 * HOUR); await h.manager.tick();
    expect(h.started).toEqual(["thread-1"]);

    vi.setSystemTime(START + 4 * HOUR + 30 * MINUTE);
    let finished = false;
    const pass = h.manager.tick().then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(SCHEDULER_STOP_WAIT_MS - 1);
    expect([finished, h.manager.isTicking, h.started.length]).toEqual([false, true, 1]);
    await vi.advanceTimersByTimeAsync(1);
    await pass;
    expect([finished, h.manager.isTicking]).toEqual([true, false]);
    expect(h.started).toEqual(["thread-1", "thread-2"]);
    expect(h.runs().map((run) => [run.routineName, run.status])).toEqual([["Runs too long", "failed"], ["Must still fire", "running"]]);
    expect(h.manager.schedulerState()).toEqual({ unreadable: false, slowStops: 1 });
    expect(warn.mock.calls.flat().join(" ")).toContain("did not finish in 10 s");
  });

  it("does not keep a cancelled run's caller waiting either", async () => {
    vi.useFakeTimers({ now: START });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    h.options.now = () => Date.now();
    h.options.interruptTurn = () => new Promise<void>(() => {});
    h.restart();
    const routine = h.manager.create(every(60));
    h.manager.runNow(routine.id); await h.manager.tick();
    const cancelled = h.manager.cancelRun(h.runs()[0]!.id, "Stopped by the person");
    await vi.advanceTimersByTimeAsync(SCHEDULER_STOP_WAIT_MS);
    await expect(cancelled).resolves.toMatchObject({ status: "cancelled" });
  });
});

describe("a routines.json that cannot be read", () => {
  const broken = '{"version":1,"routines":[{"id":"r1","name":"Fix new bugs","prompt":"Look for new bug rep';
  const corrupt = () => {
    const h = harness();
    h.manager.create(every(60));
    const good = readFileSync(h.file, "utf8");
    h.manager.close();
    writeFileSync(h.file, broken);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.at(START + 10 * MINUTE); h.manager = new RoutineManager(h.options);
    return { h, good, error };
  };

  it("is left as it is with a copy beside it, runs nothing, refuses changes, and is flagged for the app and the health report", async () => {
    const { h, error } = corrupt();
    expect(h.manager.listRoutines()).toEqual([]);
    expect(h.manager.schedulerState()).toEqual({ unreadable: true, slowStops: 0 });
    expect(() => h.manager.create(every(30))).toThrow("Saved routines could not be read");
    await h.tickAt(START + HOUR);
    h.manager.holdFor(["no_connections"]); h.manager.markAllSeen(); h.manager.stop(); h.manager.close();
    expect(readFileSync(h.file, "utf8")).toBe(broken);
    const copies = readdirSync(dirname(h.file)).filter((name) => name.startsWith("routines.json.unreadable-"));
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(dirname(h.file), copies[0]!), "utf8")).toBe(broken);
    expect(error).toHaveBeenCalledTimes(1);
    const logged = error.mock.calls.flat().join(" ");
    expect(logged).toContain("cannot be read (invalid JSON)");
    expect(logged).toContain(copies[0]);
    expect(logged).not.toContain("Fix new bugs");
    expect(h.started).toEqual([]);
  });

  it("is read again until it works: its routines come back, the app is told, and the run that was due starts", async () => {
    const { h, good, error } = corrupt();
    let readable = 0;
    h.options.onReadable = () => { readable += 1; };
    await h.tickAt(START + 20 * MINUTE);
    await h.tickAt(START + 30 * MINUTE);
    expect([readable, h.manager.schedulerState().unreadable, error.mock.calls.length]).toEqual([0, true, 1]);

    writeFileSync(h.file, good);
    h.emitted.length = 0;
    await h.tickAt(START + HOUR);
    expect([readable, h.manager.schedulerState().unreadable]).toEqual([1, false]);
    expect(h.manager.listRoutines()).toMatchObject([{ name: "Fix new bugs", enabled: true }]);
    expect(h.emitted.some((frame) => frame.kind === "routine")).toBe(true);
    expect(h.started).toEqual(["thread-1"]);
    expect(h.disk().runs).toMatchObject([{ status: "running" }]);
    expect(h.manager.create(every(30, { name: "Another" }))).toMatchObject({ name: "Another" });
  });

  it("is looked at again every minute by the running scheduler, with nothing else due", async () => {
    const h = harness();
    h.manager.create(every(60));
    const good = readFileSync(h.file, "utf8");
    h.manager.close();
    writeFileSync(h.file, broken);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ now: START + HOUR });
    h.options.now = () => Date.now();
    h.restart();
    h.manager.start();
    await vi.advanceTimersByTimeAsync(3 * UNREADABLE_RETRY_MS);
    expect(h.manager.schedulerState().unreadable).toBe(true);
    writeFileSync(h.file, good);
    await vi.advanceTimersByTimeAsync(UNREADABLE_RETRY_MS + 1_000);
    expect(h.manager.schedulerState().unreadable).toBe(false);
    expect(h.started).toEqual(["thread-1"]);
    h.manager.stop();
  });

  it("saves through a temporary file and a rename, so a reader never sees half a file", () => {
    const h = harness();
    h.manager.create(every(60));
    expect(readdirSync(dirname(h.file))).toEqual(["routines.json"]);
    expect(() => JSON.parse(readFileSync(h.file, "utf8"))).not.toThrow();
  });
});
