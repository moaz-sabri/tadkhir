import { withTx } from "../data/db.js";
import { reader, guardQuota } from "../data/stores.js";
import { createSession, addSessionItem, removeSessionItem, toggleSessionTask, updateSessionNote, pause as epause, resume as eresume, finish as efinish, cancel as ecancel } from "../domain/session-engine.js";
import { ActiveSessionExistsError, NotFoundError, ValidationError } from "../domain/errors.js";
import { MAX_TITLE } from "../domain/validation.js";
import { bus } from "../app/bus.js";
import { haptics } from "../app/haptics.js";
import { notifications } from "../app/notifications.js";
import { broadcastChange } from "../app/sync.js";
import { syncService } from "./sync-service.js";

const tasks = reader("task");
const sessions = reader("session");
const events = reader("event");

const T_SESSION = "session";
const T_EVENT = "event";
const T_TASK = "task";

const act = () => Date.now();

function notify() {
    bus.emit("data-changed");
    broadcastChange();
}

async function activeOp(engine) {
    const out = await withTx(["sessions", "events", "tasks"], "readwrite", async r => {
        const sr = sessions(r);
        const er = events(r);
        const tr = tasks(r);
        const s = await sr.getActive();
        if (!s) throw new NotFoundError("session", "active");

        const result = engine(s, act());
        await sr.put(result.session);
        await er.add(result.event);

        let taskUpdate = null;
        if (result.session.status === "completed" && result.session.taskId) {
            const t = await tr.get(result.session.taskId);
            if (t) {
                taskUpdate = { ...t, usageCount: t.usageCount + 1, lastUsedAt: result.session.endedAt, updatedAt: act() };
                await tr.put(taskUpdate);
            }
        }
        return { result, taskUpdate };
    });
    const session = out.result.session;
    // Pause/resume keeps the session local (it is still "current"). Only the
    // final record syncs â€” together with ITS FULL event journal â€” so another
    // device gets the complete history at the moment the session is finished.
    if (session.status === "completed" || session.status === "cancelled") {
        const journal = await withTx(["events"], "readonly", r => events(r).bySession(session.id));
        // One outbox transaction for the journal and the session, instead of
        // one per event: a long session carries a lot of them.
        await syncService.enqueueMany([
            ...journal.map(e => ({ type: T_EVENT, id: e.id, op: "upsert", data: e, at: e.at })),
            { type: T_SESSION, id: session.id, op: "upsert", data: session },
            ...(out.taskUpdate ? [{ type: T_TASK, id: out.taskUpdate.id, op: "upsert", data: out.taskUpdate }] : [])
        ]);
    }
    notify();
    return session;
}

export const sessionService = {
    // Start a session on a task, or on nothing with an optional title. A bare
    // string is still accepted as a task id so existing callers are unchanged.
    // The title is only ever a label for a free session â€” it is not a task and
    // creates nothing.
    //
    // `routineId` is the third way in, and it is a LINK rather than a third kind
    // of session: a timed routine starts the app's own timer, with the routine's
    // own title and its own length, and the only trace it leaves on the record is
    // which rule it came from. Everything downstream - the countdown, the estimate
    // alert, the journal, the reports, the one-active-session rule - is the path a
    // task-backed session has always taken. There is deliberately no routine branch
    // in here: a routine with its own session type would be a second timer, and
    // two timers drift.
    //
    // THIS IS ALSO WHERE THE NOTIFICATION PERMISSION IS ASKED FOR, and the
    // position of the line is the whole point. It is the first statement, so it
    // runs in the same task as the tap that started the session — some engines
    // refuse a permission prompt that is not inside the gesture that led to it,
    // and by the time the first `await` below has resolved the gesture is gone.
    //
    // It is here rather than at startup because this is the first moment at which
    // an alert means anything to the person being asked: a prompt on first launch
    // is the fastest way to teach someone to dismiss prompts, and this one only
    // appears to someone who has just started a timer, which is the very
    // behaviour it would be offering. It is one prompt per browser either way —
    // `ask()` returns immediately once the answer is anything but "undecided" —
    // and it asks nobody who has turned notifications off.
    async start(input) {
        notifications.ask().catch(() => {});

        const { taskId, title, routineId = null, durationMs = 0 } = typeof input === "string" || input == null
            ? { taskId: input ?? null, title: null, routineId: null, durationMs: 0 }
            : {
                taskId: input.taskId ?? null,
                title: input.title ?? null,
                routineId: input.routineId ?? null,
                durationMs: input.durationMs ?? 0
            };
        const label = typeof title === "string" ? title.trim() : "";
        if (label.length > MAX_TITLE) throw new ValidationError("title", "too_long");
        // The routine link, or nothing. `durationMs` is only ever the routine's
        // own length, and only ever reaches createSession when a routine named
        // itself: a free session with a stray number must stay a free session, or
        // a caller that grew an estimate field by accident would quietly turn
        // every one of them into a countdown against nothing.
        const routine = typeof routineId === "string" && routineId ? routineId : null;
        if (routine && routine.length > MAX_TITLE) throw new ValidationError("routineId", "too_long");
        if (!Number.isInteger(durationMs) || durationMs < 0) {
            throw new ValidationError("durationMs", "out_of_range");
        }

        const out = await withTx(["tasks", "sessions", "events"], "readwrite", async r => {
            let task = null;
            if (taskId) {
                task = await tasks(r).get(taskId);
                if (!task) throw new NotFoundError("task", taskId);
                if (task.archived) throw new ValidationError("task", "archived");
            }

            const s = await sessions(r).getActive();
            if (s) throw new ActiveSessionExistsError(s.id);

            await guardQuota(r, T_SESSION);

            const created = createSession({
                id: crypto.randomUUID(),
                task,
                title: label || null,
                now: act(),
                routineId: routine,
                durationMs
            });
            await sessions(r).put(created.session);
            await events(r).add(created.event);
            return created;
        });
        // The running session stays device-local until it finishes: nothing is
        // enqueued here. The full session + its event journal is pushed once at
        // finish/cancel, so other devices only ever see completed sessions.
        // The pulse is here and not at the call sites so that every one of the
        // four ways into this method — the home launcher, a task row, a task's
        // detail screen, the share sheet — answers the same way.
        haptics.do("start");
        notify();
        return out.session;
    },

    // Toggle a session-scoped task checkbox. Reads the active session from the
    // DB first, applies the immutable transition, then writes session + event
    // in a single transaction (all-or-nothing). Tasks are never modified.
    async toggleTask(taskId, completed) {
        const out = await withTx(["sessions", "events"], "readwrite", async r => {
            const sr = sessions(r);
            const er = events(r);
            const s = await sr.getActive();
            if (!s) throw new NotFoundError("session", "active");

            const result = toggleSessionTask(s, taskId, Boolean(completed), act());
            if (!result.event) return result;

            await sr.put(result.session);
            await er.add(result.event);
            return result;
        });
        if (out.event) notify(); // running session â€” local only
        return out.session;
    },

    async addItem(title) {
        const out = await withTx(["sessions", "events"], "readwrite", async r => {
            const sr = sessions(r);
            const er = events(r);
            const s = await sr.getActive();
            if (!s) throw new NotFoundError("session", "active");

            const result = addSessionItem(s, title, act());
            if (!result.event) return result;

            await sr.put(result.session);
            await er.add(result.event);
            return result;
        });
        notify(); // running session â€” local only
        return out.session;
    },

    async removeItem(itemId) {
        const out = await withTx(["sessions", "events"], "readwrite", async r => {
            const sr = sessions(r);
            const er = events(r);
            const s = await sr.getActive();
            if (!s) throw new NotFoundError("session", "active");

            const result = removeSessionItem(s, itemId, act());
            if (!result.event) return result;

            await sr.put(result.session);
            await er.add(result.event);
            return result;
        });
        notify(); // running session â€” local only
        return out.session;
    },

    // Save the session journal note. Operates on the active session by default,
    // or on any session by id (so notes can be edited after the session ends).
    async saveNote(id, note) {
        const out = await withTx(["sessions", "events"], "readwrite", async r => {
            const sr = sessions(r);
            const er = events(r);
            const s = id ? await sr.get(id) : await sr.getActive();
            if (!s) throw new NotFoundError("session", id || "active");

            const result = updateSessionNote(s, note, act());
            if (!result.event) return result;

            await sr.put(result.session);
            await er.add(result.event);
            return result;
        });
        if (out.event) {
            // A note on the CURRENT session stays local (it syncs at finish
            // alongside the whole journal). Editing a finished session's note
            // syncs immediately so every device sees the same journal.
            if (out.session.status !== "running" && out.session.status !== "paused") {
                await syncService.enqueueMany([
                    { type: T_SESSION, id: out.session.id, op: "upsert", data: out.session },
                    { type: T_EVENT, id: out.event.id, op: "upsert", data: out.event, at: out.event.at }
                ]);
            }
            notify();
        }
        return out.session;
    },

    pause: () => activeOp(epause),
    resume: () => activeOp(eresume),
    finish: () => activeOp(efinish),
    cancel: () => activeOp(ecancel),

    async get(id) {
        return withTx(["sessions"], "readonly", r => sessions(r).get(id));
    },

    async list() {
        return withTx(["sessions"], "readonly", r => sessions(r).getAll());
    },

    async events(id) {
        return withTx(["events"], "readonly", r => events(r).bySession(id));
    },

    async remove(id) {
        const journal = await withTx(["sessions", "events"], "readwrite", async r => {
            const er = events(r);
            const list = await er.bySession(id);
            await er.deleteBySession(id);
            await sessions(r).delete(id);
            return list;
        });
        // One outbox transaction for the session and its whole journal. A
        // long session deletes a lot of events, and each one used to cost its
        // own transaction.
        await syncService.enqueueMany([
            { type: T_SESSION, id, op: "delete", data: null, at: act() },
            ...journal.map(e => ({ type: T_EVENT, id: e.id, op: "delete", data: null, at: e.at }))
        ]);
        notify();
    }
};