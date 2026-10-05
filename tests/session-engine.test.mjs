import test from "node:test";
import assert from "node:assert/strict";
import {
    createSession,
    toggleSessionTask,
    addSessionItem,
    removeSessionItem,
    updateSessionNote,
    elapsedMs,
    isOver,
    hasEstimate,
    pause,
    resume,
    finish,
    cancel,
} from "../app/js/domain/session-engine.js";
import { InvalidTransitionError, NotFoundError, ValidationError } from "../app/js/domain/errors.js";
import { MAX_DURATION_MS, MAX_SESSION_ITEMS } from "../app/js/domain/validation.js";

test("createSession starts a running session with an open segment", () => {
    const { session, event } = createSession({ id: "s1", now: 1000 });
    assert.equal(session.id, "s1");
    assert.equal(session.status, "running");
    assert.equal(session.activeSlot, 1);
    assert.deepEqual(session.segments, [{ start: 1000, end: null }]);
    assert.equal(session.taskId, null);
    assert.equal(session.taskTitle, null);
    assert.equal(event.type, "session.started");
    assert.equal(event.at, 1000);
});

// isOver() was exported with no caller for the whole of this app's life, and so
// it said that a FREE session — one with estimatedMs 0 — was over from the
// moment it started. Every screen that actually asked the question had grown the
// same guard by hand, which is what a guard in the wrong place looks like. It
// matters now: the estimate alert that fires this (and buzzes, and can raise a
// notification) is the alert a user is most likely to switch off.
test("a free session is never over, however long it runs", () => {
    const { session } = createSession({ id: "s1", title: "phone call", now: 0 });
    assert.equal(session.estimatedMs, 0);
    assert.equal(hasEstimate(session), false);
    assert.equal(isOver(session, 0), false);
    assert.equal(isOver(session, 60_000), false);
    assert.equal(isOver(session, 25 * 60 * 60 * 1000), false);
});

test("a session with no task is not measured against a stray estimate", () => {
    // Only a hand-written import can produce this, and the engine now has to
    // answer for it: a session that is not on a task is not measured against
    // anything, which is what every screen in the app has always done.
    const { session } = createSession({ id: "s1", title: "phone call", now: 0 });
    const stray = { ...session, estimatedMs: 60_000, segments: [{ start: -300_000, end: null }] };
    assert.equal(hasEstimate(stray), false);
    assert.equal(isOver(stray, 0), false);
});

test("a session with an estimate is over exactly at it", () => {
    const at = 1_000_000;
    const task = { id: "t1", title: "Deep work", estimatedMs: 25 * 60 * 1000, subtasks: [] };
    const { session } = createSession({ id: "s1", task, now: at });
    assert.equal(hasEstimate(session), true);
    assert.equal(isOver(session, at), false);
    assert.equal(isOver(session, at + 25 * 60 * 1000 - 1), false);
    assert.equal(isOver(session, at + 25 * 60 * 1000), true);
    assert.equal(isOver(session, at + 40 * 60 * 1000), true);
});

test("createSession snapshots task context", () => {    const task = { id: "t1", title: "Write", estimatedMs: 60000, subtasks: [{ id: "st1", title: "A" }] };
    const { session } = createSession({ id: "s2", task, now: 2000 });
    assert.equal(session.taskId, "t1");
    assert.equal(session.taskTitle, "Write");
    assert.equal(session.estimatedMs, 60000);
    assert.deepEqual(session.taskItems, [{ id: "st1", title: "A", completed: false }]);
});

test("toggleSessionTask is a no-op when the value is unchanged", () => {
    const task = { id: "t", title: "T", estimatedMs: 60000, subtasks: [{ id: "st", title: "A" }] };
    const { session } = createSession({ id: "s", task, now: 0 });
    // initial completed is false; toggling to false is a no-op
    const res = toggleSessionTask(session, "st", false, 500);
    assert.equal(res.event, null);
    assert.equal(res.session.taskItems[0].completed, false);
});

test("toggleSessionTask toggles and emits events", () => {
    const task = { id: "t", title: "T", estimatedMs: 60000, subtasks: [{ id: "st", title: "A" }] };
    const { session } = createSession({ id: "s", task, now: 0 });

    const done = toggleSessionTask(session, "st", true, 100);
    assert.equal(done.session.taskItems[0].completed, true);
    assert.equal(done.event.type, "session.task.completed");

    const undone = toggleSessionTask(done.session, "st", false, 200);
    assert.equal(undone.session.taskItems[0].completed, false);
    assert.equal(undone.event.type, "session.task.uncompleted");

    const noop = toggleSessionTask(done.session, "st", true, 300);
    assert.equal(noop.event, null);

    assert.throws(() => toggleSessionTask(session, "nope", true, 100), NotFoundError);
});

test("addSessionItem trims titles and removeSessionItem deletes", () => {
    const { session } = createSession({ id: "s", now: 0 });
    const added = addSessionItem(session, "  Item  ", 50);
    assert.equal(added.session.taskItems[0].title, "Item");
    assert.equal(added.event.type, "session.item.added");

    const id = added.session.taskItems[0].id;
    const removed = removeSessionItem(added.session, id, 60);
    assert.deepEqual(removed.session.taskItems, []);
    assert.equal(removed.event.type, "session.item.removed");
    assert.equal(removed.event.data.itemId, id);

    assert.throws(() => removeSessionItem(session, "nope", 60), NotFoundError);
});

test("elapsedMs sums only closed-into-now time", () => {
    const { session } = createSession({ id: "s", now: 1000 });
    assert.equal(elapsedMs(session, 5000), 4000);
    const p = pause(session, 7000);
    assert.equal(elapsedMs(p.session, 9999), 6000); // paused: segment closed at 7000
});

test("elapsedMs stops counting at the 72h ceiling", () => {
    const { session } = createSession({ id: "s", now: 0 });
    assert.equal(elapsedMs(session, MAX_DURATION_MS), MAX_DURATION_MS);
    assert.equal(elapsedMs(session, MAX_DURATION_MS + 3_600_000), MAX_DURATION_MS);
    // finishing a capped session stores the capped actual time
    const f = finish(session, MAX_DURATION_MS + 3_600_000);
    assert.equal(f.session.actualMs, MAX_DURATION_MS);
});

test("addSessionItem validates title and count", () => {
    const { session } = createSession({ id: "s", now: 0 });
    assert.throws(() => addSessionItem(session, "   ", 10), ValidationError);
    assert.throws(() => addSessionItem(session, "x".repeat(121), 10), ValidationError);

    let s = session;
    for (let i = 0; i < MAX_SESSION_ITEMS; i++) s = addSessionItem(s, `item ${i}`, i).session;
    assert.equal(s.taskItems.length, MAX_SESSION_ITEMS);
    assert.throws(() => addSessionItem(s, "one too many", MAX_SESSION_ITEMS), ValidationError);
});

test("updateSessionNote trims, saves, clears and rejects long notes", () => {
    const { session } = createSession({ id: "s", now: 0 });

    const saved = updateSessionNote(session, "  Wrote the report  ", 1000);
    assert.equal(saved.session.note, "Wrote the report");
    assert.equal(saved.session.updatedAt, 1000);
    assert.equal(saved.event.type, "session.note.updated");

    // no-op when the value is unchanged
    const noop = updateSessionNote(saved.session, "Wrote the report", 2000);
    assert.equal(noop.event, null);

    // empty note clears back to null
    const cleared = updateSessionNote(saved.session, "   ", 3000);
    assert.equal(cleared.session.note, null);
    assert.equal(cleared.event.type, "session.note.updated");

    // over-long notes are rejected
    assert.throws(() => updateSessionNote(session, "x".repeat(2001), 4000), ValidationError);
});

test("lifecycle transitions pause -> resume -> finish/cancel", () => {
    const { session } = createSession({ id: "s", now: 0 });

    const p = pause(session, 1000);
    assert.equal(p.session.status, "paused");
    assert.equal(p.session.segments[0].end, 1000);
    assert.equal(p.event.type, "session.pause");

    assert.throws(() => pause(p.session, 2000), InvalidTransitionError);

    const r = resume(p.session, 2000);
    assert.equal(r.session.status, "running");
    assert.equal(r.session.segments.length, 2);
    assert.equal(r.session.segments[1].start, 2000);
    assert.equal(r.event.type, "session.resume");

    const f = finish(r.session, 4000);
    assert.equal(f.session.status, "completed");
    assert.equal(f.session.endedAt, 4000);
    assert.equal(f.session.actualMs, 3000); // 0..1000 + 2000..4000
    assert.equal(f.session.activeSlot, undefined);
    assert.equal(f.event.type, "session.completed");

    assert.throws(() => resume(f.session, 5000), InvalidTransitionError);
    assert.throws(() => finish(f.session, 5000), InvalidTransitionError);

    const c = cancel(session, 1500);
    assert.equal(c.session.status, "cancelled");
    assert.equal(c.event.type, "session.cancel");
});