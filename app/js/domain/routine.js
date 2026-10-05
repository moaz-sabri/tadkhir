import { validateRoutineInput } from "./validation.js";
import { dayKey } from "./time.js";

// A routine, and the day it is being asked about. Pure: no store, no clock of
// its own, no language. Everything here is a function of the record and a moment,
// which is what lets the whole feature be tested without a database.
//
// The rule and the result are kept apart on purpose. This module never decides
// what a routine has achieved by keeping a tally — a timed routine's proof is the
// session the existing timer already wrote, and a counter's proof is the day's own
// row in `routineLogs`. A second copy of either would be a copy that could
// disagree with the first.

/**
 * The record itself.
 *
 * The fields are exactly the ones the validator returned, so a stored routine is
 * always the shape the rules describe and never whatever the form happened to
 * hold — the same reason `createLaterItem` and `createPage` are written this way.
 */
export function createRoutine(input, { now: at = Date.now(), id } = {}) {
    const v = validateRoutineInput(input || {});
    return {
        id,
        kind: v.kind,
        frequency: v.frequency,
        title: v.title,
        weekday: v.weekday,
        durationMs: v.durationMs,
        target: v.target,
        reminderBeforeMs: v.reminderBeforeMs,
        reminderEveryMs: v.reminderEveryMs,
        active: v.active,
        createdAt: at,
        updatedAt: at
    };
}

/**
 * Is this routine wanted on the day `at` falls on?
 *
 * Two questions, one line each: a daily routine is wanted every day, and a weekly
 * one only on the weekday the user picked. `getDay()` numbers Sunday as 0, which
 * is the numbering the record stores, so there is no conversion anywhere.
 *
 * An inactive routine is wanted on no day. That is the only meaning `active` has:
 * it takes a rule off today's list without deleting the days it already recorded,
 * so pausing a routine is not the same act as erasing its history.
 */
export function isDueOn(routine, at = Date.now()) {
    if (!routine || routine.active === false) return false;
    if (routine.frequency === "daily") return true;
    return routine.weekday === new Date(at).getDay();
}

/**
 * The id of one routine's row for one day.
 *
 * Derived, not generated: the pair (routine, day) IS the row, so today is a `get`
 * rather than a scan, and the counter starts again by itself when the day rolls
 * over. There is no reset to run and nothing that can be left holding yesterday's
 * number. The separator is `@` because a routine id is a uuid: no uuid contains
 * one, so the pair cannot be ambiguous.
 */
export function logId(routineId, day) {
    return `${routineId}@${day}`;
}

/** Today's row for a routine, or null when nothing has been pressed yet. */
export function logFor(logsById, routineId, day) {
    return logsById.get(logId(routineId, day)) ?? null;
}

/**
 * Today's routines, with what has been done on each — the home screen's list, and
 * the only reader of "is it done".
 *
 * `done` is derived from records that already exist, never stored on the rule:
 *
 *   timed    a COMPLETED session today that carries this routine's id. The session
 *            is the existing record of the run; the routine adds nothing to it
 *            except which rule it was started from. A session from yesterday does
 *            not count, and a cancelled one never does — a run the user threw away
 *            is not a run.
 *   counter  the day's own tally, reaching the routine's own target. Passing the
 *            target is not a failure and is not clamped either: six cups really is
 *            six cups.
 *
 * A run belongs to the day it STARTED, not the day it ended, and that is the same
 * rule the read that feeds this function uses (a floor on `startedAt`) — a run
 * begun at 23:50 and finished at 00:10 is a run of the evening it was begun in.
 * Keying one on `endedAt` and the other on `startedAt` would produce a run that
 * belongs to neither day, which is the one outcome with no correct answer.
 *
 * Nothing here can report anything about an earlier day, and that is deliberate.
 * There is no "overdue", no streak and no adherence figure anywhere in this
 * module, because a day the user did not repeat is not a debt — it is just a day.
 */
export function todayView(routines, logs, sessions, now = Date.now()) {
    const day = dayKey(now);
    // Keyed by id rather than searched for: the day rows are a bounded but
    // growing list, and today's row for each routine is a lookup, not a scan.
    const logsById = new Map(logs.map(l => [l.id, l]));
    const finished = new Map();
    for (const s of sessions) {
        if (s?.status !== "completed" || typeof s.routineId !== "string" || !s.routineId) continue;
        if (dayKey(s.startedAt ?? now) !== day) continue;
        finished.set(s.routineId, (finished.get(s.routineId) ?? 0) + 1);
    }

    return routines
        .filter(r => isDueOn(r, now))
        .map(r => {
            if (r.kind === "counter") {
                const count = logFor(logsById, r.id, day)?.count ?? 0;
                return { routine: r, count, target: r.target, done: count >= r.target };
            }
            const runs = finished.get(r.id) ?? 0;
            return { routine: r, count: runs, target: null, done: runs > 0 };
        })
        .sort((a, b) => (a.routine.createdAt ?? 0) - (b.routine.createdAt ?? 0));
}
