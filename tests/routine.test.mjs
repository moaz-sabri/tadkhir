import test from "node:test";
import assert from "node:assert/strict";

// Routines: a rule the user writes once, and the records that say what they
// actually did. Four things are guarded here, in order:
//
//   1. the RULE — what a routine may be, and that the fields which do not belong
//      to its kind are cleared rather than kept;
//   2. the DAY  — what is due today, and what counts as done, with no state for
//      "late" anywhere;
//   3. the LINK — a timed routine runs on the app's existing timer, so a run is
//      an ordinary session carrying one extra id;
//   4. the REPORT — what actually happened, never what should have.

import {
    createRoutine,
    isDueOn,
    logId,
    logFor,
    todayView
} from "../app/js/domain/routine.js";
import { validateRoutineInput, assertRoutineRecords } from "../app/js/domain/validation.js";
import { assertImportShape } from "../app/js/domain/validation.js";
import { routineActivity, reportSummary } from "../app/js/domain/analytics.js";
import { createSession, hasEstimate, isOver } from "../app/js/domain/session-engine.js";
import { ValidationError, ImportError } from "../app/js/domain/errors.js";
import { migrations } from "../app/js/data/migrations.js";
import { DB_VERSION } from "../app/js/config.js";

// A Wednesday, midday, local time — so a weekly routine on 3 is due and one on 5
// is not, without the test depending on which day it happens to run.
const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime();
const HOUR = 3600000;
const DAY = 86400000;

const rejects = (input, field, code) => {
    assert.throws(
        () => validateRoutineInput(input),
        e => e instanceof ValidationError && e.field === field && e.code === code,
        `expected ${field}/${code}`
    );
};

const timed = (over = {}) => validateRoutineInput({
    kind: "timed", frequency: "daily", title: "Run", durationMs: 30 * 60000, ...over
});
const counter = (over = {}) => validateRoutineInput({
    kind: "counter", frequency: "daily", title: "Water", target: 5, ...over
});

// ---------------------------------------------------------------- the rule ---

test("a routine is a kind, a frequency, a name, and one number", () => {
    assert.deepEqual(
        { ...timed(), durationMs: 1800000 },
        {
            kind: "timed",
            frequency: "daily",
            title: "Run",
            weekday: null,
            durationMs: 1800000,
            target: null,
            reminderBeforeMs: null,
            reminderEveryMs: null,
            active: true
        }
    );
    assert.equal(counter().target, 5);
});

test("a routine needs a kind it knows and a name", () => {
    rejects({ frequency: "daily", title: "x" }, "kind", "invalid_type");
    rejects({ kind: "habit", frequency: "daily", title: "x" }, "kind", "invalid_type");
    rejects({ kind: "timed", frequency: "daily", title: "   " }, "title", "required");
    rejects({ kind: "timed", frequency: "daily" }, "title", "required");
    // A title is one short line, the same rule every other title in the app uses.
    rejects({ kind: "timed", frequency: "daily", title: "a\nb" }, "title", "invalid_type");
    rejects({ kind: "timed", frequency: "daily", title: "x".repeat(121) }, "title", "too_long");
});

test("a weekly routine is a weekday, and a daily one has none", () => {
    assert.equal(timed({ frequency: "weekly", weekday: 5 }).weekday, 5);
    assert.equal(timed({ frequency: "weekly", weekday: 0 }).weekday, 0);
    assert.equal(timed().weekday, null, "a daily routine must not keep a weekday");

    rejects({ kind: "timed", frequency: "weekly", title: "x" }, "weekday", "out_of_range");
    rejects({ kind: "timed", frequency: "weekly", title: "x", weekday: 7 }, "weekday", "out_of_range");
    rejects({ kind: "timed", frequency: "weekly", title: "x", weekday: -1 }, "weekday", "out_of_range");
    rejects({ kind: "timed", frequency: "weekly", title: "x", weekday: 1.5 }, "weekday", "out_of_range");
    // A weekday on a daily routine is a contradiction, not something to ignore:
    // it means the record claims two schedules at once.
    rejects({ kind: "timed", frequency: "daily", title: "x", weekday: 2 }, "weekday", "invalid_type");
});

test("the time is optional, and when it is there it is a real duration", () => {
    // No duration is a legitimate routine: the user starts the run when they want
    // to, and it is still recorded as this routine's.
    assert.equal(timed({ durationMs: null }).durationMs, null);
    assert.equal(timed({ durationMs: "" }).durationMs, null);

    // The bounds are the app's own, not new ones: a minute to 72 hours, exactly
    // what a task estimate accepts.
    assert.equal(timed({ durationMs: 60000 }).durationMs, 60000);
    assert.equal(timed({ durationMs: 72 * HOUR }).durationMs, 72 * HOUR);
    rejects({ ...timed(), durationMs: 59999 }, "durationMs", "out_of_range");
    rejects({ ...timed(), durationMs: 72 * HOUR + 1 }, "durationMs", "out_of_range");
    rejects({ ...timed(), durationMs: "30" }, "durationMs", "out_of_range");
});

test("a counter needs a target, and a timed routine must not carry one", () => {
    rejects({ kind: "counter", frequency: "daily", title: "x" }, "target", "out_of_range");
    rejects({ kind: "counter", frequency: "daily", title: "x", target: 0 }, "target", "out_of_range");
    rejects({ kind: "counter", frequency: "daily", title: "x", target: 1000 }, "target", "out_of_range");
    // Switching a counter into a timed routine clears the target rather than
    // keeping it: a record with both claims two shapes at once.
    rejects({ kind: "timed", frequency: "daily", title: "x", target: 5 }, "target", "invalid_type");
    rejects({ kind: "counter", frequency: "daily", title: "x", target: 5, durationMs: 60000 }, "durationMs", "invalid_type");
});

test("reminders come from closed lists, and a value outside one is refused", () => {
    assert.equal(counter({ reminderEveryMs: HOUR }).reminderEveryMs, HOUR);
    assert.equal(timed({ frequency: "weekly", weekday: 5, reminderBeforeMs: HOUR }).reminderBeforeMs, HOUR);
    assert.equal(counter({ reminderEveryMs: null }).reminderEveryMs, null);

    rejects({ ...counter(), reminderEveryMs: 900000 }, "reminderEveryMs", "invalid_type");
    rejects({ ...timed(), reminderBeforeMs: 1 }, "reminderBeforeMs", "invalid_type");
    rejects({ ...timed(), reminderBeforeMs: "3600000" }, "reminderBeforeMs", "invalid_type");
});

test("inactive is a state, not a kind: a paused routine is still the same routine", () => {
    const paused = timed({ active: false });
    assert.equal(paused.active, false);
    assert.equal(paused.title, "Run");
    assert.equal(timed({}).active, true, "a routine is active unless it says otherwise");
});

// ------------------------------------------------------------------- record ---

test("createRoutine produces exactly the record the feature promised", () => {
    const routine = createRoutine(
        { kind: "counter", frequency: "weekly", weekday: 5, title: " Water ", target: 8 },
        { now: NOW, id: "r1" }
    );
    assert.deepEqual(routine, {
        id: "r1",
        kind: "counter",
        frequency: "weekly",
        title: "Water",
        weekday: 5,
        durationMs: null,
        target: 8,
        reminderBeforeMs: null,
        reminderEveryMs: null,
        active: true,
        createdAt: NOW,
        updatedAt: NOW
    });
});

test("a weekly routine created without a weekday is refused rather than guessed", () => {
    // Monday is not a sensible default to invent: a routine on the wrong day is
    // a routine that shows up on days the user never asked for.
    assert.throws(
        () => createRoutine({ kind: "timed", frequency: "weekly", title: "x", durationMs: 60000 }, { id: "r" }),
        ValidationError
    );
});

// -------------------------------------------------------------------- today ---

const rule = (over = {}) => createRoutine(
    { kind: "timed", frequency: "daily", title: "Run", durationMs: 30 * 60000, ...over },
    { now: NOW, id: over.id || "r1" }
);

test("a daily routine is due every day and a weekly one only on its weekday", () => {
    const daily = rule();
    assert.equal(isDueOn(daily, NOW), true);
    assert.equal(isDueOn(daily, NOW + 5 * DAY), true);

    const friday = rule({ frequency: "weekly", weekday: 5, id: "r2" });
    assert.equal(isDueOn(friday, NOW), false, "Wednesday is not Friday");
    assert.equal(isDueOn(friday, new Date(2026, 9, 2, 9, 0, 0).getTime()), true);
});

test("a paused routine is wanted on no day at all", () => {
    assert.equal(isDueOn(rule({ active: false }), NOW), false);
    assert.equal(isDueOn(rule({ frequency: "weekly", weekday: 3, active: false }), NOW), false);
});

test("the day row is named after the routine and the day, so it needs no reset", () => {
    const today = "2026-09-30";
    assert.equal(logId("r1", today), `r1@${today}`);
    assert.equal(logId("r1", today), logId("r1", today), "the same pair is the same row");
    assert.notEqual(logId("r1", today), logId("r1", "2026-10-01"), "a new day is a new row");

    const rows = [{ id: logId("r1", "2026-10-01"), routineId: "r1", dayKey: "2026-10-01", count: 4, updatedAt: NOW }];
    const byId = new Map(rows.map(r => [r.id, r]));
    assert.equal(logFor(byId, "r1", "2026-10-01").count, 4);
    assert.equal(logFor(byId, "r1", "2026-09-30"), null, "a day with no row has nothing, and says nothing");
});

test("a counter with no row today reads 0 / target, which is a real answer", () => {
    const water = rule({ kind: "counter", target: 5, durationMs: null });
    const [view] = todayView([water], [], [], NOW);
    assert.equal(view.count, 0);
    assert.equal(view.target, 5);
    assert.equal(view.done, false);
});

test("a counter is done when the day reaches its target, and past it still is", () => {
    const water = rule({ kind: "counter", target: 5, durationMs: null });
    const day = "2026-09-30";
    const withCount = n => todayView(
        [water],
        [{ id: logId("r1", day), routineId: "r1", dayKey: day, count: n, updatedAt: NOW }],
        [],
        NOW
    )[0];

    assert.equal(withCount(4).done, false);
    assert.equal(withCount(5).done, true);
    assert.equal(withCount(6).done, true, "six cups is six cups, not an error");
    assert.equal(withCount(6).count, 6, "and it is not clamped back down to the target");
});

test("yesterday's count is not today's count", () => {
    const water = rule({ kind: "counter", target: 5, durationMs: null });
    const yesterday = "2026-09-29";
    const [view] = todayView(
        [water],
        [{ id: logId("r1", yesterday), routineId: "r1", dayKey: yesterday, count: 5, updatedAt: NOW - DAY }],
        [],
        NOW
    );
    assert.equal(view.count, 0, "the day starts again by itself");
    assert.equal(view.done, false, "and nothing about yesterday makes it late");
});

test("a timed routine is done by a completed session of TODAY", () => {
    const run = rule();
    const session = id => ({
        id, status: "completed", routineId: "r1", startedAt: NOW, endedAt: NOW, actualMs: 1800000
    });
    assert.equal(todayView([run], [], [], NOW)[0].done, false);
    assert.equal(todayView([run], [], [session("s1")], NOW)[0].done, true);
    // Yesterday's run is history, not today's progress — and there is no state in
    // which that makes the routine late.
    const yesterday = { ...session("s2"), startedAt: NOW - DAY, endedAt: NOW - DAY };
    assert.equal(todayView([run], [], [yesterday], NOW)[0].done, false);
    // A cancelled run is a run the user threw away.
    assert.equal(todayView([run], [], [{ ...session("s3"), status: "cancelled" }], NOW)[0].done, false);
    // Another routine's run is not this one's.
    assert.equal(todayView([run], [], [{ ...session("s4"), routineId: "other" }], NOW)[0].done, false);
});

test("a run belongs to the day it was started, not the day it ended", () => {
    // 23:50 yesterday, finished at 00:10 today. Keying the day on `endedAt` would
    // hand it to a day the user never pressed Start on, and keying the READ on
    // `startedAt` while the MATCH on `endedAt` would leave it belonging to
    // neither — which is the one answer that cannot be defended.
    const run = rule();
    const overnight = {
        id: "s1",
        status: "completed",
        routineId: "r1",
        startedAt: NOW - 20 * 60000,
        endedAt: NOW + 10 * 60000,
        actualMs: 1800000
    };
    assert.equal(todayView([run], [], [overnight], NOW)[0].done, true,
        "it is yesterday evening's run, and this evening is the day it started");
    assert.equal(todayView([run], [], [overnight], NOW + DAY)[0].done, false,
        "and tomorrow it is history like any other");
});

test("today shows only what is wanted today, in the order the user made them", () => {
    const first = rule({ id: "a", title: "First", createdAt: 1 });
    const second = rule({ id: "b", title: "Second", createdAt: 2 });
    const friday = rule({ id: "c", title: "Friday", frequency: "weekly", weekday: 5, createdAt: 3 });
    const paused = rule({ id: "d", title: "Paused", active: false, createdAt: 4 });

    const views = todayView([first, second, friday, paused], [], [], NOW);
    assert.deepEqual(views.map(v => v.routine.id), ["a", "b"]);
});

test("no day but today can be asked about", () => {
    // The home screen's whole answer. If this list ever grows a field about a
    // previous day, this is the test that says so.
    const water = rule({ kind: "counter", target: 5, durationMs: null });
    const [view] = todayView([water], [], [], NOW);
    assert.deepEqual(Object.keys(view).sort(), ["count", "done", "routine", "target"]);
    assert.ok(!("late" in view) && !("overdue" in view) && !("streak" in view));
});

// ---------------------------------------------------------------- the link ----

test("a timed routine runs on the app's own timer, with its length as the estimate", () => {
    const { session } = createSession({
        id: "s1",
        title: "Run",
        now: NOW,
        routineId: "r1",
        durationMs: 30 * 60000
    });
    assert.equal(session.routineId, "r1");
    assert.equal(session.taskId, null, "a routine is not a task by another name");
    assert.equal(session.taskTitle, "Run");
    assert.equal(session.estimatedMs, 1800000);
    assert.deepEqual(session.taskItems, [], "and it brings no subtasks with it");

    // Which means it is measured exactly like a task-backed session: a countdown,
    // and the alert that has always fired when the estimate is reached.
    assert.equal(hasEstimate(session), true);
    assert.equal(isOver(session, NOW + 1800000 - 1), false);
    assert.equal(isOver(session, NOW + 1800000), true);
});

test("a routine with no duration starts a session with nothing to measure against", () => {
    const { session } = createSession({ id: "s1", title: "Wash the car", now: NOW, routineId: "r1", durationMs: 0 });
    assert.equal(session.routineId, "r1");
    assert.equal(session.estimatedMs, 0);
    assert.equal(hasEstimate(session), false, "an untimed run is not over anything");
    assert.equal(isOver(session, NOW + 25 * HOUR), false);
});

test("an ordinary session is untouched by all of this", () => {
    const free = createSession({ id: "s1", title: "phone call", now: NOW });
    assert.equal("routineId" in free.session, false, "no field at all, rather than a null that syncs");
    assert.equal(free.session.estimatedMs, 0);
    assert.equal(hasEstimate(free.session), false);
    assert.equal(isOver(free.session, 25 * HOUR), false);

    // A stray estimate with nothing to attach it to is still not measured, which
    // is what every screen in the app has always done.
    const stray = { ...free.session, estimatedMs: 60000 };
    assert.equal(hasEstimate(stray), false);

    const task = { id: "t1", title: "Deep work", estimatedMs: 1500000, subtasks: [] };
    const onTask = createSession({ id: "s2", task, now: NOW });
    assert.equal(onTask.session.routineId, undefined);
    assert.equal(hasEstimate(onTask.session), true);
});

// -------------------------------------------------------------- the report ---

const completed = (over = {}) => ({
    id: "s1",
    status: "completed",
    startedAt: NOW,
    endedAt: NOW,
    actualMs: 30 * 60000,
    ...over
});

test("the report counts what happened and lists nothing else", () => {
    const run = rule({ id: "run", title: "Run", createdAt: 1 });
    const water = rule({ id: "water", kind: "counter", target: 5, durationMs: null, createdAt: 2 });
    const never = rule({ id: "never", title: "Never started", createdAt: 3 });

    const day = "2026-09-30";
    const activity = routineActivity({
        routines: [run, water, never],
        routineLogs: [{ id: logId("water", day), routineId: "water", dayKey: day, count: 4, updatedAt: NOW }],
        sessions: [completed({ id: "s1", routineId: "run" })]
    }, null);

    assert.deepEqual(activity.routines.map(r => r.id), ["run", "water"]);
    assert.equal(activity.routines.some(r => r.id === "never"), false,
        "a routine with no activity in the window is not a row of zeroes");
    assert.equal(activity.runs, 1);
    assert.equal(activity.totalMs, 1800000);
    assert.equal(activity.counterDays, 1);

    const waterRow = activity.routines.find(r => r.id === "water");
    assert.equal(waterRow.count, 4);
    assert.equal(waterRow.days, 1);
    assert.equal(waterRow.target, 5);
    assert.equal(waterRow.runs, 0);
});

test("the report is sliced by the same period the rest of the reports use", () => {
    const water = rule({ id: "water", kind: "counter", target: 5, durationMs: null });
    const day = "2026-09-30";
    const log = { id: logId("water", day), routineId: "water", dayKey: day, count: 3, updatedAt: NOW };

    // "This week" starts on the Monday before NOW, so today's row is inside it and
    // a row from before it is not.
    const inWeek = routineActivity({ routines: [water], routineLogs: [log], sessions: [] }, NOW - 3 * DAY);
    assert.equal(inWeek.counterDays, 1);
    assert.equal(inWeek.routines[0].count, 3);

    const later = routineActivity({ routines: [water], routineLogs: [log], sessions: [] }, NOW + DAY);
    assert.deepEqual(later.routines, [], "a window that has not reached it reports nothing at all");
    assert.equal(later.counterDays, 0);
});

test("a day row at zero is not activity", () => {
    const water = rule({ id: "water", kind: "counter", target: 5, durationMs: null });
    const day = "2026-09-30";
    const activity = routineActivity({
        routines: [water],
        routineLogs: [{ id: logId("water", day), routineId: "water", dayKey: day, count: 0, updatedAt: NOW }],
        sessions: []
    }, null);
    assert.deepEqual(activity.routines, [], "a counter that was opened and not pressed is nothing to report");
});

test("a paused routine still reports what it did while it was on", () => {
    // Pausing is not erasing. The days are already recorded and the reports are
    // where they are read.
    const run = rule({ id: "run", active: false });
    const activity = routineActivity({ routines: [run], routineLogs: [], sessions: [completed({ routineId: "run" })] }, null);
    assert.equal(activity.runs, 1);
    assert.equal(activity.routines[0].id, "run");
});

test("routine time is part of the time already reported, not extra time", () => {
    // The same session is counted by the period's own figures and attributed here,
    // so the two cards cannot add up to more time than was spent.
    const run = rule({ id: "run" });
    const summary = reportSummary({
        sessions: [completed({ routineId: "run" })],
        routines: [run],
        routineLogs: []
    }, "week", NOW);
    assert.equal(summary.count, 1);
    assert.equal(summary.totalMs, 1800000);
    assert.equal(summary.routine.totalMs, 1800000);
    assert.equal(summary.routine.runs, 1);
});

// ------------------------------------------------------------------ records ---

const stored = (over = {}) => ({
    id: "r1",
    kind: "timed",
    frequency: "daily",
    title: "Run",
    weekday: null,
    durationMs: 1800000,
    target: null,
    reminderBeforeMs: null,
    reminderEveryMs: null,
    active: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...over
});

test("a real set of records is accepted and a broken one is not", () => {
    const log = { id: "r1@2026-09-30", routineId: "r1", dayKey: "2026-09-30", count: 3, updatedAt: NOW };
    assert.equal(assertRoutineRecords({ routines: [stored()], routineLogs: [log] }), true);
    assert.equal(assertRoutineRecords({ routines: [], routineLogs: [] }), true);

    const fails = over => assert.throws(
        () => assertRoutineRecords({ routines: [stored(over)], routineLogs: [] }),
        ImportError
    );
    fails({ kind: "habit" });
    fails({ title: "" });
    fails({ weekday: 9 });
    fails({ target: -1 });
    fails({ updatedAt: 0 });

    const badLog = over => assert.throws(
        () => assertRoutineRecords({ routines: [], routineLogs: [{ ...log, ...over }] }),
        ImportError
    );
    badLog({ dayKey: "30-09-2026" });
    badLog({ count: -1 });
    badLog({ count: 1.5 });
    badLog({ routineId: "" });
    badLog({ updatedAt: null });
});

test("a backup without routines still imports, and one with them is still a v1 backup", () => {
    const base = {
        app: "task-timer",
        version: 1,
        tasks: [],
        sessions: [],
        events: [],
        settings: {}
    };
    assert.equal(assertImportShape(base), true);
    assert.equal(assertImportShape({
        ...base,
        routines: [stored()],
        routineLogs: [{ id: "r1@2026-09-30", routineId: "r1", dayKey: "2026-09-30", count: 3, updatedAt: NOW }]
    }), true, "routines must not bump the backup format version");
    // A day row with no rule is a number nothing can place, and half a set is not
    // a state anything can draw.
    assert.throws(() => assertImportShape({
        ...base,
        routines: [],
        routineLogs: [{ id: "r1@2026-09-30", routineId: "r1", dayKey: "nope", count: 3, updatedAt: NOW }]
    }), ImportError);
});

// --------------------------------------------------------------- migrations ---

// The minimal slice of IDBDatabase a migration touches.
function stubDb() {
    const stores = new Map();
    return {
        stores,
        createObjectStore(name) {
            assert.equal(stores.has(name), false, `${name} must not already exist`);
            const indexes = new Set();
            stores.set(name, { name, indexes, rows: [] });
            return {
                indexNames: { contains: i => indexes.has(i) },
                createIndex: i => indexes.add(i),
                put: row => stores.get(name).rows.push(row)
            };
        },
        objectStoreNames: { contains: name => stores.has(name) }
    };
}

const indexNames = (db, store) => [...db.stores.get(store).indexes];

test("DB_VERSION has moved past the Later migration, which is still 6", () => {
    assert.ok(DB_VERSION > 6, `DB_VERSION should have moved past 6, is ${DB_VERSION}`);
    assert.equal(typeof migrations[6], "function");
    assert.equal(typeof migrations[10], "function");
});

test("migration 10 adds two stores and seeds nothing", () => {
    const db = stubDb();
    migrations[10](db);
    assert.deepEqual([...db.stores.keys()], ["routines", "routineLogs"]);
    // No index on the rules: the store is capped at MAX_ROUTINES and every screen
    // reads the whole list, exactly like `later`.
    assert.deepEqual(indexNames(db, "routines"), []);
    // Two on the days, and both serve a read that exists: one routine's own
    // history, and today's rows. The cascade rides on the same first index.
    assert.deepEqual(indexNames(db, "routineLogs"), ["routineId", "dayKey"]);
    // An empty pair of stores is a valid state: a user who opens Routines and
    // writes nothing has the same database as one who never opened it.
    assert.deepEqual(db.stores.get("routines").rows, []);
    assert.deepEqual(db.stores.get("routineLogs").rows, []);
});

test("migration 10 is additive: an existing database is left exactly as it was", () => {
    const db = stubDb();
    for (let v = 1; v <= 9; v++) migrations[v](db);
    const before = new Map([...db.stores].map(([k, v]) => [k, [...v.indexes]]));

    migrations[10](db);

    assert.equal(db.stores.size, before.size + 2);
    for (const [name, indexes] of before) {
        assert.deepEqual([...db.stores.get(name).indexes], indexes, `${name} was touched`);
    }
});
