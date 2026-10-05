import { InvalidTransitionError, NotFoundError, ValidationError } from "./errors.js";
import { MAX_DURATION_MS, MAX_ITEM_TITLE, MAX_NOTE, MAX_SESSION_ITEMS } from "./validation.js";

const copy = x => structuredClone(x);

export const FREE_SESSION_ESTIMATE_MS = 0;

function safeNow(session, now) {
    let last = session.segments.at(-1)?.end
        ?? session.segments.at(-1)?.start
        ?? session.createdAt;
    return Math.max(now, last);
}

function snapshotTaskItems(subtasks) {
    if (!Array.isArray(subtasks)) return [];
    return subtasks.map(x => ({ id: x.id, title: x.title, completed: false }));
}

// A free session may carry a title instead of a task. That is how "just a
// phone call", "gym" or any other unnamed work gets a type to filter and report
// by, without inventing a task the user never asked for. A task always wins:
// when there is one, its title and estimate are the truth.
//
// `routineId` is the one link a session carries besides a task: the routine this
// run was started from, so the reports can say which rule the time belongs to.
// It changes nothing about how the session runs — the session IS the app's timer,
// and a routine uses it rather than having one of its own. `durationMs` is the
// rule's length, which becomes this session's estimate and nothing more: it is
// what puts a countdown and the existing end-of-estimate alert on the screen, both
// of which the task case has always had.
export function createSession({ id, task = null, title = null, now, routineId = null, durationMs = 0 }) {
    const at = now;
    const label = task ? task.title : (typeof title === "string" ? title.trim() : "") || null;
    const routineIdValue = typeof routineId === "string" && routineId ? routineId : null;
    const session = {
        id,
        taskId: task ? task.id : null,
        taskTitle: label,
        estimatedMs: task ? task.estimatedMs : (routineIdValue ? durationMs || 0 : 0),
        taskItems: snapshotTaskItems(task ? task.subtasks : null),
        note: null,
        // Only ever set when the session really was started from a routine, so a
        // session written before routines existed has no field here at all rather
        // than a null one that syncs as if it did.
        ...(routineIdValue ? { routineId: routineIdValue } : {}),
        status: "running",
        segments: [{ start: at, end: null }],
        startedAt: at,
        endedAt: null,
        actualMs: null,
        createdAt: at,
        updatedAt: at,
        activeSlot: 1
    };
    return {
        session,
        event: { id: crypto.randomUUID(), sessionId: id, type: "session.started", at, data: null }
    };
}

// Immutable per-session task checkbox transition. Returns a fresh session and
// the type of event the caller must persist. A no-op toggle returns the same
// session value unchanged so the caller can skip writing entirely.
export function toggleSessionTask(session, taskId, completed, at) {
    const s = copy(session);
    const items = s.taskItems || [];
    const idx = items.findIndex(x => x.id === taskId);
    if (idx === -1) throw new NotFoundError("sessionTask", taskId);
    if (items[idx].completed === Boolean(completed)) {
        return { session: s, event: null };
    }
    items[idx] = { ...items[idx], completed: Boolean(completed) };
    s.taskItems = items;
    s.updatedAt = at;
    return {
        session: s,
        event: {
            id: crypto.randomUUID(),
            sessionId: s.id,
            type: completed ? "session.task.completed" : "session.task.uncompleted",
            at,
            data: { taskId }
        }
    };
}

export function addSessionItem(session, title, at) {
    const clean = String(title).trim();
    if (!clean) throw new ValidationError("title", "required");
    if (clean.length > MAX_ITEM_TITLE) throw new ValidationError("title", "too_long");
    if ((session.taskItems || []).length >= MAX_SESSION_ITEMS) {
        throw new ValidationError("items", "too_many");
    }
    const s = copy(session);
    const item = { id: crypto.randomUUID(), title: clean, completed: false };
    s.taskItems = [...(s.taskItems || []), item];
    s.updatedAt = at;
    return {
        session: s,
        event: {
            id: crypto.randomUUID(),
            sessionId: s.id,
            type: "session.item.added",
            at,
            data: { item }
        }
    };
}

export function removeSessionItem(session, itemId, at) {
    const s = copy(session);
    const items = s.taskItems || [];
    const idx = items.findIndex(x => x.id === itemId);
    if (idx === -1) throw new NotFoundError("sessionItem", itemId);
    const [item] = items.splice(idx, 1);
    s.taskItems = items;
    s.updatedAt = at;
    return {
        session: s,
        event: {
            id: crypto.randomUUID(),
            sessionId: s.id,
            type: "session.item.removed",
            at,
            data: { itemId, title: item.title }
        }
    };
}

// Session journal: a free-form note attached to the session, edited while the
// session runs (or later on the detail page). A no-op write returns the same
// session value unchanged so the caller can skip persisting.
export function updateSessionNote(session, note, at) {
    const clean = String(note ?? "").trim();
    if (clean.length > MAX_NOTE) throw new ValidationError("note", "too_long");
    if ((session.note ?? "") === clean) {
        return { session: copy(session), event: null };
    }
    const s = copy(session);
    s.note = clean || null;
    s.updatedAt = at;
    return {
        session: s,
        event: {
            id: crypto.randomUUID(),
            sessionId: s.id,
            type: "session.note.updated",
            at,
            data: null
        }
    };
}

export function elapsedMs(session, now) {
    let total = 0;
    for (const s of session.segments) {
        total += Math.max(0, (s.end ?? now) - s.start);
    }
    // A session can never count beyond the 72 h ceiling: after that the timer
    // stops counting (the UI warns instead).
    return Math.min(MAX_DURATION_MS, total);
}

export function remainingMs(session, now) {
    return session.estimatedMs - elapsedMs(session, now);
}

// Does this session have an estimate to be over?
//
// Two things are required, and both had been re-typed at every call site that
// asked the question (`taskId && estimatedMs > 0 && elapsed >= estimatedMs`):
// the session is backed by a task, and that task carried an estimate. A free
// session's `estimatedMs` is 0, so the first test is what keeps "elapsed >= 0"
// from being true one millisecond after an untimed session starts — which is what
// this function said before, and which is why it had no caller: nothing that
// asked was willing to use it.
//
// A record with neither a task nor a routine, but a stray estimate (only a
// hand-written import can produce one) is treated as having none, because that is
// what every screen has always done with it: a session that belongs to nothing is
// not measured against anything.
//
// The rule does have a second door, and it is deliberately the same shape rather
// than a second question. A session started from a ROUTINE carries that rule's
// duration as its estimate, so a timed routine gets the countdown and the estimate
// alert a task has always had — out of the existing timer, with no second one to
// keep in step. What it does NOT get is the task side: no subtasks, no usage
// count, nothing that would make a routine a task by another name.
//
// `remainingMs` above is deliberately left as plain arithmetic and can go
// negative: an overrun past a real estimate is a real thing, and how far past is
// worth reporting. What is NOT a real thing is a session with no estimate at all
// being over, which is why only this function guards.
export function hasEstimate(session) {
    return !!(session.taskId || session.routineId) && session.estimatedMs > 0;
}

export function isOver(session, now) {
    if (!hasEstimate(session)) return false;
    return elapsedMs(session, now) >= session.estimatedMs;
}

function transition(session, action, now) {
    const s = copy(session);
    const at = safeNow(s, now);
    const last = s.segments.at(-1);

    if (action === "pause") {
        if (s.status !== "running") throw new InvalidTransitionError(s.status, action);
        last.end = at;
        s.status = "paused";
    } else if (action === "resume") {
        if (s.status !== "paused") throw new InvalidTransitionError(s.status, action);
        s.segments.push({ start: at, end: null });
        s.status = "running";
    } else if (action === "finish" || action === "cancel") {
        if (!["running", "paused"].includes(s.status)) {
            throw new InvalidTransitionError(s.status, action);
        }
        if (s.status === "running") last.end = at;
        s.status = action === "finish" ? "completed" : "cancelled";
        s.endedAt = at;
        s.actualMs = elapsedMs(s, at);
        delete s.activeSlot;
    } else {
        throw new InvalidTransitionError(s.status, action);
    }

    s.updatedAt = at;
    return {
        session: s,
        event: {
            id: crypto.randomUUID(),
            sessionId: s.id,
            type: `session.${action === "finish" ? "completed" : action}`,
            at,
            data: null
        }
    };
}

export const pause = (s, n) => transition(s, "pause", n);
export const resume = (s, n) => transition(s, "resume", n);
export const finish = (s, n) => transition(s, "finish", n);
export const cancel = (s, n) => transition(s, "cancel", n);