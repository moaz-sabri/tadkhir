import { withTx } from "../data/db.js";
import { reader, guardQuota } from "../data/stores.js";
import { validateRoutineInput, MAX_ROUTINE_COUNT } from "../domain/validation.js";
import { createRoutine, isDueOn, logId, todayView } from "../domain/routine.js";
import { dayKey, startOfDay } from "../domain/time.js";
import { NotFoundError, ValidationError } from "../domain/errors.js";
import { bus } from "../app/bus.js";
import { broadcastChange } from "../app/sync.js";
import { syncService } from "./sync-service.js";
import { sessionService } from "./session-service.js";

const routines = reader("routine");
const logs = reader("routineLog");

// The generic record protocol, unchanged: { type, id, op, data, updatedAt } into
// the existing outbox, the existing push, the existing encryption, the existing
// last-write-wins and the existing tombstones. No transport of its own, no
// endpoint, no server-side logic — the same two lines every other service here
// carries.
const T_ROUTINE = "routine";
const T_LOG = "routineLog";

const now = () => Date.now();

function notify() {
    bus.emit("data-changed");
    broadcastChange();
}

export const routineService = {
    // ------------------------------------------------------------ read side

    /**
     * Every rule, in the order the user made them.
     *
     * The order is derived on read rather than stored, for the reason every other
     * list in this app derives its own: a local order is not a fact that survives
     * another device. Inactive rules come last rather than disappearing — a rule
     * the user paused is still theirs, and the days it recorded are still in the
     * reports.
     */
    async list() {
        const all = await withTx(["routines"], "readonly", r => routines(r).getAll());
        return sortRoutines(all);
    },

    async get(id) {
        const routine = await withTx(["routines"], "readonly", r => routines(r).get(id));
        if (!routine) throw new NotFoundError("routine", id);
        return routine;
    },

    /**
     * Today's routines with what has been done on each.
     *
     * ONE transaction over three stores, because the answer is a comparison
     * between them: a timed routine is done because of a session, and a counter
     * because of today's row. Reading the three one service at a time would be
     * three transactions and three moments, and a run finished between the second
     * and the third would be reported as not done on a screen that has just seen
     * it done.
     *
     * Both reads are bounded by the question rather than by the store, and both
     * use an index that already existed:
     *   - the days: `byDay`, so today's rows and not every day this device keeps;
     *   - the sessions: `sinceStarted(start of today)`, because the only session
     *     that can prove a routine was run today is one that STARTED today. A
     *     session from yesterday is history, and reading the whole table to say
     *     so would be a question about 500 records asked to answer one about
     *     today's handful.
     *
     * The `startedAt` window is a floor, not a filter on the whole day: a session
     * that starts at 23:50 and ends at 00:10 tomorrow belongs to the day it
     * started, which is the day the user pressed Start on the routine.
     */
    async today(at = now()) {
        const day = dayKey(at);
        const from = startOfDay(at);
        const data = await withTx(
            ["routines", "routineLogs", "sessions"],
            "readonly",
            async r => ({
                routines: await routines(r).getAll(),
                logs: await logs(r).byDay(day),
                sessions: await reader("session")(r).sinceStarted(from)
            })
        );
        return todayView(data.routines, data.logs, data.sessions, at);
    },

    /** Whether any rule exists at all — what the home screen hides an empty list on. */
    async count() {
        return withTx(["routines"], "readonly", r => routines(r).count());
    },

    /**
     * A routine's own recorded days, oldest first.
     *
     * Read through the store's index rather than by filtering everything, and
     * capped by MAX_ROUTINE_LOGS across all routines — this is the one read that
     * is not "the whole list".
     */
    async history(routineId) {
        return withTx(["routineLogs"], "readonly", r => logs(r).byRoutine(routineId));
    },

    // ----------------------------------------------------------- write side

    async create(input) {
        const at = now();
        const x = validateRoutineInput(input);
        const routine = createRoutine(x, { now: at, id: crypto.randomUUID() });
        await withTx(["routines"], "readwrite", async r => {
            await guardQuota(r, T_ROUTINE);
            await routines(r).put(routine);
        });
        await syncService.enqueue(T_ROUTINE, routine.id, "upsert", routine);
        notify();
        return routine;
    },

    async update(id, patch) {
        const at = now();
        const current = await this.get(id);
        // Validated through the same function as a create, from the same merged
        // shape, so an edit cannot produce a record the form could not have made.
        const x = validateRoutineInput({ ...current, ...patch });
        // `active` is its own switch rather than a field of the form, because it
        // is the one edit that does not change what the routine IS — it takes it
        // off today's list while leaving every day it already recorded alone.
        const routine = {
            ...current,
            kind: x.kind,
            frequency: x.frequency,
            title: x.title,
            weekday: x.weekday,
            durationMs: x.durationMs,
            target: x.target,
            reminderBeforeMs: x.reminderBeforeMs,
            reminderEveryMs: x.reminderEveryMs,
            active: x.active,
            updatedAt: at
        };
        await withTx(["routines"], "readwrite", r => routines(r).put(routine));
        await syncService.enqueue(T_ROUTINE, id, "upsert", routine);
        notify();
        return routine;
    },

    /**
     * Removes a rule and the days it recorded, in one transaction.
     *
     * The cascade is not tidiness. A day row is a number with nothing to place it:
     * with the rule gone, no screen can say "3" about anything, and it would go on
     * syncing forever as a record nothing can render. One transaction rather than
     * two, so there is no moment in which the rule is gone and its days are not —
     * the same rule `pageService.remove` and `financeService.removeDebt` follow.
     */
    async remove(id) {
        const at = now();
        const rows = await withTx(["routines", "routineLogs"], "readwrite", async r => {
            const rl = logs(r);
            // Read the days BEFORE deleting them, and inside the same
            // transaction: each one needs its own tombstone, and a row read after
            // the delete would be gone by then.
            const existing = await rl.byRoutine(id);
            await routines(r).delete(id);
            await rl.deleteByRoutine(id);
            return existing;
        });
        await syncService.enqueueMany([
            { type: T_ROUTINE, id, op: "delete", data: null, at },
            // Each day row is its own tombstone, queued in the same batch as the
            // rule's: a device that kept them would push them back forever.
            ...rows.map(row => ({ type: T_LOG, id: row.id, op: "delete", data: null, at: row.updatedAt }))
        ]);
        notify();
        // So the board can drop a card that pointed here. The sessions the rule
        // produced are NOT touched — they are ordinary sessions and belong to the
        // sessions list, whether or not the rule that started them still exists.
        bus.emit("record-deleted", { service: "routine", id });
    },

    /**
     * One press on a counter: `delta` is +1 or -1.
     *
     * The read and the write are one transaction, because two quick presses would
     * otherwise both read 0 and write 1. Nothing else in the app needs that care
     * for a counter, and a counter that loses a press is exactly the kind of quiet
     * wrongness this feature must not have.
     *
     * The row is the pair (routine, day), so a new day is a new row and the
     * counter is at 0 again because there is nothing to carry over — there is no
     * reset to forget and no midnight job to miss.
     *
     * Pressing below 0 is not possible and asking for it is refused rather than
     * clamped, so a caller that got its signs the wrong way round finds out. The
     * top is clamped at MAX_ROUTINE_COUNT because a number nobody could have
     * pressed is a corrupted record, not a fact.
     */
    async bump(id, delta, at = now()) {
        if (delta !== 1 && delta !== -1) throw new ValidationError("count", "out_of_range");
        const routine = await this.get(id);
        if (routine.kind !== "counter") throw new ValidationError("kind", "invalid_type");
        const day = dayKey(at);
        const key = logId(id, day);

        const row = await withTx(["routineLogs"], "readwrite", async r => {
            const current = await logs(r).get(key);
            const next = (current?.count ?? 0) + delta;
            if (next < 0) throw new ValidationError("count", "out_of_range");
            const out = {
                id: key,
                routineId: id,
                dayKey: day,
                count: Math.min(next, MAX_ROUTINE_COUNT),
                updatedAt: at
            };
            await logs(r).put(out);
            return out;
        });

        await syncService.enqueue(T_LOG, row.id, "upsert", row);
        notify();
        return row;
    },

    /**
     * Starts a timed routine on the app's own timer.
     *
     * The session is created by `sessionService`, which is the only thing in this
     * app that creates one: the routine contributes a title, a length and the id
     * it wants the run attributed to, and nothing else. That is the whole reason
     * there is no second timer here — the countdown, the estimate alert, the wake
     * lock, the journal, the one-session-at-a-time rule and the reports all come
     * from the code that already did them for tasks.
     *
     * A routine with no duration starts an untimed session, which is the same
     * thing the home screen's free-session launcher starts. "No time is binding"
     * means the run still counts as this routine's, not that it is refused.
     */
    async start(id) {
        const routine = await this.get(id);
        if (routine.kind !== "timed") throw new ValidationError("kind", "invalid_type");
        return sessionService.start({
            routineId: routine.id,
            title: routine.title,
            durationMs: routine.durationMs ?? 0
        });
    },

    /**
     * Whether this rule belongs on the day `at` falls on.
     *
     * Asked here rather than re-derived at each call site, for the same reason
     * `kanbanService.board` owns the board's day filter: the home list, the list
     * screen's "today" section and the reports must not be able to disagree about
     * which day a routine is for.
     */
    isDueOn(routine, at) {
        return isDueOn(routine, at);
    }
};

// Oldest first, active before inactive. Derived on every read, never stored —
// the same rule `splitLater` follows.
function sortRoutines(all) {
    return [...all].sort((a, b) =>
        Number(b.active === false) - Number(a.active === false)
        || (a.createdAt ?? 0) - (b.createdAt ?? 0)
        || String(a.id).localeCompare(String(b.id))
    );
}
