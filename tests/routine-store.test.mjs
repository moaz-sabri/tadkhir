// The routine service against a real (stubbed) database.
//
// The pure half of this feature is in routine.test.mjs: what a routine may be,
// and what counts as done. What is left needs a store, and these are the four
// claims about it that the pure half cannot make:
//
//   1. a counter's day row is ONE row per (routine, day), and a new day needs no
//      reset — so there is nothing to forget to run at midnight;
//   2. two presses in a row do not lose one;
//   3. deleting a rule takes its days with it, in the same transaction, so no
//      number is left behind that nothing can place;
//   4. a timed routine's run is an ordinary session — one row in `sessions`, with
//      the rule's duration as its estimate — and not a second kind of session.

import test from "node:test";
import assert from "node:assert/strict";
import { installFakeIndexedDB } from "./helpers/fake-indexeddb.mjs";

const idb = installFakeIndexedDB();
const { withTx } = await import("../app/js/data/db.js");
const { reader } = await import("../app/js/data/stores.js");
const { routineService } = await import("../app/js/services/routine-service.js");
const { sessionService } = await import("../app/js/services/session-service.js");
const { logId } = await import("../app/js/domain/routine.js");
const { dayKey } = await import("../app/js/domain/time.js");

const routines = reader("routine");
const logs = reader("routineLog");
const sessions = reader("session");

const DAY1 = new Date(2026, 8, 30, 9, 0, 0).getTime();
const DAY2 = new Date(2026, 9, 1, 9, 0, 0).getTime();

const counter = () => routineService.create({
    kind: "counter", frequency: "daily", title: "Water", target: 5
});

// Wiped before AND after every test, and `fresh()` is called first thing inside
// each one. A test that fails half way through must not leave its records behind
// for the next one, or the failure is then reported against a quota or a list it
// had nothing to do with — which is exactly what happened the first time.
const fresh = () => idb.wipe();

test("one counter, one row per day, and nothing to reset", async () => {
    fresh();
    const routine = await counter();

    await routineService.bump(routine.id, 1, DAY1);
    await routineService.bump(routine.id, 1, DAY1);
    await routineService.bump(routine.id, 1, DAY1);

    const stored = await withTx(["routineLogs"], "readonly", r => logs(r).getAll());
    assert.equal(stored.length, 1, "three presses on one day are one row");
    assert.equal(stored[0].count, 3);
    assert.equal(stored[0].dayKey, dayKey(DAY1));

    // The next day is a different row, so the counter is at zero again without
    // anything having run at midnight.
    await routineService.bump(routine.id, 1, DAY2);
    const both = await withTx(["routineLogs"], "readonly", r => logs(r).getAll());
    assert.equal(both.length, 2);
    assert.deepEqual(both.map(r => r.count).sort(), [1, 3]);

    const today = await routineService.today(DAY2);
    assert.equal(today[0].count, 1, "today reads today's row only");
    assert.equal(today[0].done, false);

    idb.wipe();
});

test("a press that would go below zero is refused rather than clamped", async () => {
    fresh();
    const routine = await counter();
    await assert.rejects(
        () => routineService.bump(routine.id, -1, DAY1),
        e => e.code === "out_of_range",
        "there is nothing to take away from an empty counter"
    );
    const stored = await withTx(["routineLogs"], "readonly", r => logs(r).getAll());
    assert.equal(stored.length, 0, "and the refusal wrote nothing");

    // And a delta that is not a press at all is a caller's mistake, not a value.
    await assert.rejects(() => routineService.bump(routine.id, 5, DAY1), e => e.code === "out_of_range");
    await assert.rejects(() => routineService.bump(routine.id, 0, DAY1), e => e.code === "out_of_range");

    idb.wipe();
});

test("a counter is the only kind that can be pressed, and a timed one only started", async () => {
    fresh();
    const run = await routineService.create({
        kind: "timed", frequency: "daily", title: "Run", durationMs: 30 * 60000
    });
    const water = await counter();

    await assert.rejects(
        () => routineService.bump(run.id, 1, DAY1),
        e => e.code === "invalid_type",
        "a timed routine produces sessions, never a tally"
    );
    await assert.rejects(
        () => routineService.start(water.id),
        e => e.code === "invalid_type",
        "and a counter has nothing to start — there is no session to run"
    );
    // Nothing was written by either refusal.
    const sessions = await withTx(["sessions"], "readonly", r => reader("session")(r).getAll());
    assert.deepEqual(sessions, []);

    idb.wipe();
});

test("deleting a rule takes its days with it", async () => {
    fresh();
    const routine = await counter();
    const other = await counter();
    await routineService.bump(routine.id, 1, DAY1);
    await routineService.bump(other.id, 1, DAY1);

    await routineService.remove(routine.id);

    const left = await withTx(["routineLogs"], "readonly", r => logs(r).getAll());
    assert.deepEqual(left.map(r => r.routineId), [other.id], "only this rule's own days went");

    const rules = await withTx(["routines"], "readonly", r => routines(r).getAll());
    assert.deepEqual(rules.map(r => r.id), [other.id]);

    idb.wipe();
});

test("a timed routine runs on the app's own timer, as an ordinary session", async () => {
    fresh();
    const run = await routineService.create({
        kind: "timed", frequency: "daily", title: "Run", durationMs: 30 * 60000
    });

    const session = await routineService.start(run.id);

    // One row in `sessions` — the store that already existed, with the fields it
    // already had. Nothing about it is routine-shaped except the one link.
    const all = await withTx(["sessions"], "readonly", r => sessions(r).getAll());
    assert.equal(all.length, 1);
    assert.equal(all[0].id, session.id);
    assert.equal(session.routineId, run.id);
    assert.equal(session.taskId, null, "no task was created for it");
    assert.equal(session.taskTitle, "Run");
    assert.equal(session.estimatedMs, 1800000, "the rule's length is the estimate the timer counts down to");
    assert.equal(session.status, "running");

    // And the rule is answered by that session the moment it ends — which is the
    // only way a routine is ever "done", and there is no other state.
    await sessionService.finish();
    const [view] = await routineService.today();
    assert.equal(view.done, true);

    idb.wipe();
});

test("a routine with no duration still records the run", async () => {
    fresh();
    const car = await routineService.create({
        kind: "timed", frequency: "weekly", weekday: 5, title: "Wash the car"
    });
    const session = await routineService.start(car.id);
    assert.equal(session.estimatedMs, 0, "no time was binding");
    assert.equal(session.routineId, car.id);

    await sessionService.finish();
    // Friday's routine is not wanted on a Wednesday, and asking anyway says so
    // rather than inventing a row.
    assert.deepEqual(await routineService.today(), []);

    idb.wipe();
});

test("the quota guard refuses the 101st routine with the registry's own code", async () => {
    fresh();
    const { MAX_ROUTINES } = await import("../app/js/domain/validation.js");
    for (let i = 0; i < MAX_ROUTINES; i++) {
        await routineService.create({ kind: "counter", frequency: "daily", title: `W${i}`, target: 5 });
    }
    await assert.rejects(
        () => routineService.create({ kind: "counter", frequency: "daily", title: "one too many", target: 5 }),
        e => e.code === "routines_limit" && e.field === "routines"
    );

    idb.wipe();
});

test("a run from yesterday does not make today's routine look finished", async () => {
    fresh();
    const run = await routineService.create({
        kind: "timed", frequency: "daily", title: "Run", durationMs: 30 * 60000
    });
    // Yesterday's completed run, written straight into the store the way it would
    // arrive from another device. The read is a floor on `startedAt`, so this is
    // the boundary it has to get right: there is no "overdue" state to fall into,
    // only today's question or no answer.
    await withTx(["sessions"], "readwrite", r => reader("session")(r).put({
        id: "yesterday",
        taskId: null,
        taskTitle: "Run",
        routineId: run.id,
        estimatedMs: 1800000,
        taskItems: [],
        note: null,
        status: "completed",
        segments: [{ start: Date.now() - 2 * 86400000, end: Date.now() - 2 * 86400000 }],
        startedAt: Date.now() - 2 * 86400000,
        endedAt: Date.now() - 2 * 86400000,
        actualMs: 1800000,
        createdAt: Date.now() - 2 * 86400000,
        updatedAt: Date.now() - 2 * 86400000
    }));

    const [view] = await routineService.today();
    assert.equal(view.done, false);
    assert.equal(view.count, 0);

    idb.wipe();
});

test("a run in progress does not complete the routine yet", async () => {
    fresh();
    const run = await routineService.create({
        kind: "timed", frequency: "daily", title: "Run", durationMs: 30 * 60000
    });
    // The shape of the run that crosses midnight: started a minute ago, still
    // going. The read's floor is on `startedAt`, so it is today's row — and a run
    // that has not ENDED is not a finished run, which is the whole rule. The
    // session's own screen says the same thing by offering Start until it ends.
    const now = Date.now();
    await withTx(["sessions"], "readwrite", r => reader("session")(r).put({
        id: "overnight",
        taskId: null,
        taskTitle: "Run",
        routineId: run.id,
        estimatedMs: 1800000,
        taskItems: [],
        note: null,
        status: "running",
        segments: [{ start: now - 60_000, end: null }],
        startedAt: now - 60_000,
        endedAt: null,
        actualMs: null,
        createdAt: now - 60_000,
        updatedAt: now
    }));

    const [view] = await routineService.today();
    assert.equal(view.done, false);
    assert.equal(view.count, 0);

    idb.wipe();
});

test("the day row id is the pair, so a second device cannot fork it", async () => {
    fresh();
    const routine = await counter();
    await routineService.bump(routine.id, 1, DAY1);

    const key = logId(routine.id, dayKey(DAY1));
    const stored = await withTx(["routineLogs"], "readonly", r => logs(r).get(key));
    assert.ok(stored, "the row is addressable by its own name, which is how two devices agree on it");
    assert.equal(stored.routineId, routine.id);
    assert.equal(stored.dayKey, dayKey(DAY1));

    idb.wipe();
});
