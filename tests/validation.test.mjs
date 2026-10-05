import test from "node:test";
import assert from "node:assert/strict";
import {
    validateTaskInput,
    assertSessionInvariant,
    assertImportShape,
    MIN_ESTIMATE,
    MAX_ESTIMATE,
    MAX_DURATION_MS,
    MAX_SUBTASKS,
    MAX_TASKS,
    MAX_SESSIONS,
    MAX_PLANNED_PAST_MS,
    MAX_PLANNED_FUTURE_MS,
    plannedAtIsValid,
    subtaskLimitForEstimate,
} from "../app/js/domain/validation.js";
import { ValidationError, ImportError } from "../app/js/domain/errors.js";

function expectValidation(field, code, input) {
    assert.throws(() => validateTaskInput(input), (e) => {
        return e instanceof ValidationError && e.field === field && e.code === code;
    });
}

test("validateTaskInput normalizes a valid input", () => {
    const plannedAt = Date.now() + 24 * 60 * 60 * 1000;
    const out = validateTaskInput({
        title: "  Cook dinner  ",
        estimatedMs: 30 * 60 * 1000,
        note: "  with rice  ",
        plannedAt,
        id: "t1",
    });
    assert.equal(out.title, "Cook dinner");
    assert.equal(out.note, "with rice");
    assert.equal(out.plannedAt, plannedAt);
    assert.deepEqual(out.subtasks, []);
});

test("validateTaskInput requires a non-empty title", () => {
    assert.throws(() => validateTaskInput({ estimatedMs: MIN_ESTIMATE }), ValidationError);
    expectValidation("title", "invalid_type", { title: 7, estimatedMs: MIN_ESTIMATE });
    expectValidation("title", "required", { title: "   ", estimatedMs: MIN_ESTIMATE });
    expectValidation("title", "too_long", { title: "a".repeat(121), estimatedMs: MIN_ESTIMATE });
});

test("validateTaskInput enforces estimatedMs bounds", () => {
    expectValidation("estimatedMs", "out_of_range", { title: "x", estimatedMs: MIN_ESTIMATE - 1 });
    expectValidation("estimatedMs", "out_of_range", { title: "x", estimatedMs: MAX_ESTIMATE + 1 });
    expectValidation("estimatedMs", "out_of_range", { title: "x", estimatedMs: 1.5 });
    expectValidation("estimatedMs", "out_of_range", { title: "x", estimatedMs: "60000" });
    // exact bounds pass
    assert.equal(validateTaskInput({ title: "x", estimatedMs: MIN_ESTIMATE }).estimatedMs, MIN_ESTIMATE);
    assert.equal(validateTaskInput({ title: "x", estimatedMs: MAX_ESTIMATE }).estimatedMs, MAX_ESTIMATE);
});

test("validateTaskInput validates note and plannedAt", () => {
    expectValidation("note", "invalid_type", { title: "x", estimatedMs: MIN_ESTIMATE, note: 42 });
    expectValidation("note", "too_long", { title: "x", estimatedMs: MIN_ESTIMATE, note: "a".repeat(2001) });
    expectValidation("plannedAt", "out_of_range", { title: "x", estimatedMs: MIN_ESTIMATE, plannedAt: 0 });
    expectValidation("plannedAt", "out_of_range", { title: "x", estimatedMs: MIN_ESTIMATE, plannedAt: -1 });
    // outside the planner window (1y past .. 2y future)
    //
    // The margin matters in BOTH directions. validateTaskInput takes its own
    // Date.now(), a moment after the one below, so a value built as "boundary
    // + 1" lands INSIDE the window whenever the clock ticks over in between —
    // which is roughly one run in four, and the assertion then fails with
    // "Missing expected exception". A second of slack is far more than any
    // clock drift and still exactly on the wrong side of the rule. The
    // boundary itself is pinned exactly in the fixed-now test below.
    const now = Date.now();
    const margin = 1000; // 1 second
    expectValidation("plannedAt", "out_of_range", {
        title: "x", estimatedMs: MIN_ESTIMATE, plannedAt: now - MAX_PLANNED_PAST_MS - margin,
    });
    expectValidation("plannedAt", "out_of_range", {
        title: "x", estimatedMs: MIN_ESTIMATE, plannedAt: now + MAX_PLANNED_FUTURE_MS + margin,
    });
    // inside the window still passes - same margin, inside the boundary
    const safeMargin = margin;
    assert.equal(
        validateTaskInput({ title: "x", estimatedMs: MIN_ESTIMATE, plannedAt: now - MAX_PLANNED_PAST_MS + safeMargin }).plannedAt,
        now - MAX_PLANNED_PAST_MS + safeMargin
    );
    assert.equal(
        validateTaskInput({ title: "x", estimatedMs: MIN_ESTIMATE, plannedAt: now + MAX_PLANNED_FUTURE_MS - safeMargin }).plannedAt,
        now + MAX_PLANNED_FUTURE_MS - safeMargin
    );
});

test("plannedAtIsValid applies the planner window against a fixed now", () => {
    const now = Date.UTC(2026, 8, 23); // fixed 2026-09-23 reference
    assert.equal(plannedAtIsValid(now - MAX_PLANNED_PAST_MS, now), true);        // exactly 1y past
    assert.equal(plannedAtIsValid(now - MAX_PLANNED_PAST_MS - 1, now), false);   // just older
    assert.equal(plannedAtIsValid(now + MAX_PLANNED_FUTURE_MS, now), true);      // exactly 2y ahead
    assert.equal(plannedAtIsValid(now + MAX_PLANNED_FUTURE_MS + 1, now), false); // just further
    assert.equal(plannedAtIsValid(0, now), false);
    assert.equal(plannedAtIsValid(-5, now), false);
    assert.equal(plannedAtIsValid(1.5, now), false);
    assert.equal(plannedAtIsValid(null, now), false);
    assert.equal(plannedAtIsValid(now, now), true);
});

test("subtasks are normalized and deduped", () => {
    const out = validateTaskInput({
        title: "x",
        estimatedMs: 30 * 60 * 1000,
        subtasks: [
            { id: "same", title: "  a  " },
            { id: "same", title: "b" },       // duplicate id -> dropped
            { title: "   " },                  // empty title -> dropped
            { id: "c", title: "c" },
        ],
    });
    assert.deepEqual(out.subtasks, [
        { id: "same", title: "a" },
        { id: "c", title: "c" },
    ]);

    assert.throws(() => validateTaskInput({ title: "x", estimatedMs: 30 * 60 * 1000, subtasks: "nope" }), ValidationError);
});

test("subtask quota is one per minute of estimate, capped at MAX_SUBTASKS", () => {
    // 5-min estimate allows exactly 5 subtasks.
    const five = validateTaskInput({
        title: "x",
        estimatedMs: 5 * 60 * 1000,
        subtasks: Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, title: `t${i}` })),
    });
    assert.equal(five.subtasks.length, 5);

    // A 6th subtask on a 5-min estimate is rejected.
    assert.throws(
        () => validateTaskInput({
            title: "x",
            estimatedMs: 5 * 60 * 1000,
            subtasks: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, title: `t${i}` })),
        }),
        (e) => e instanceof ValidationError && e.field === "subtasks" && e.code === "too_many"
    );

    // 10-min estimate allows exactly 10 subtasks.
    const ten = validateTaskInput({
        title: "x",
        estimatedMs: 10 * 60 * 1000,
        subtasks: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, title: `t${i}` })),
    });
    assert.equal(ten.subtasks.length, 10);

    // 30-min estimate is capped at MAX_SUBTASKS (25).
    const maxed = validateTaskInput({
        title: "x",
        estimatedMs: 30 * 60 * 1000,
        subtasks: Array.from({ length: MAX_SUBTASKS }, (_, i) => ({ id: `s${i}`, title: `t${i}` })),
    });
    assert.equal(maxed.subtasks.length, MAX_SUBTASKS);

    // Anything above the global cap is rejected no matter the estimate.
    assert.throws(
        () => validateTaskInput({
            title: "x",
            estimatedMs: 72 * 60 * 1000,
            subtasks: Array.from({ length: MAX_SUBTASKS + 1 }, (_, i) => ({ id: `s${i}`, title: `t${i}` })),
        }),
        (e) => e instanceof ValidationError && e.code === "too_many"
    );
});

test("subtaskLimitForEstimate maps minutes to quota", () => {
    assert.equal(subtaskLimitForEstimate(0), MAX_SUBTASKS);
    assert.equal(subtaskLimitForEstimate(1 * 60000), 1);
    assert.equal(subtaskLimitForEstimate(5 * 60000), 5);
    assert.equal(subtaskLimitForEstimate(10 * 60000), 10);
    assert.equal(subtaskLimitForEstimate(25 * 60000), 25);
    assert.equal(subtaskLimitForEstimate(72 * 60 * 60000), 25);
});

test("hard ceilings: 72h estimate, 100 tasks, 500 sessions", () => {
    assert.equal(MAX_ESTIMATE, 72 * 60 * 60 * 1000);
    assert.equal(MAX_DURATION_MS, MAX_ESTIMATE);
    assert.equal(MAX_TASKS, 100);
    assert.equal(MAX_SESSIONS, 500);
    // 72h bricks pass, one minute over fails.
    assert.equal(validateTaskInput({ title: "x", estimatedMs: MAX_ESTIMATE }).estimatedMs, MAX_ESTIMATE);
    expectValidation("estimatedMs", "out_of_range", { title: "x", estimatedMs: MAX_ESTIMATE + 1 });
});

test("assertSessionInvariant accepts a valid running session", () => {
    assert.equal(
        assertSessionInvariant({
            status: "running",
            segments: [{ start: 100, end: null }],
        }),
        true
    );
});

test("assertSessionInvariant rejects malformed sessions", () => {
    assert.throws(
        () => assertSessionInvariant({ status: "weird", segments: [] }),
        (e) => e instanceof ImportError && e.code === "invalid_schema" && e.detail === "status"
    );
    assert.throws(
        () => assertSessionInvariant({ status: "completed", segments: [{ start: 1, end: 2 }] }),
        (e) => e instanceof ImportError && e.code === "invalid_schema" && e.detail === "ended_session"
    );
    assert.throws(
        () => assertSessionInvariant({
            status: "completed",
            segments: [{ start: 100, end: 50 }],
            endedAt: 200,
            actualMs: 50,
        }),
        (e) => e instanceof ImportError && e.code === "invalid_schema" && e.detail === "segment_order"
    );
});

test("assertSessionInvariant validates the optional session note", () => {
    // missing note is fine (older backups)
    assert.equal(
        assertSessionInvariant({ status: "running", segments: [{ start: 1, end: null }] }),
        true
    );
    // valid string note passes
    assert.equal(
        assertSessionInvariant({ status: "running", segments: [{ start: 1, end: null }], note: "journal" }),
        true
    );
    // non-string note rejected
    assert.throws(
        () => assertSessionInvariant({ status: "running", segments: [{ start: 1, end: null }], note: 42 }),
        (e) => e instanceof ImportError && e.code === "invalid_schema" && e.detail === "session_note"
    );
    // over-long note rejected
    assert.throws(
        () => assertSessionInvariant({ status: "running", segments: [{ start: 1, end: null }], note: "x".repeat(2001) }),
        (e) => e instanceof ImportError && e.code === "invalid_schema" && e.detail === "session_note"
    );
});

test("assertImportShape gatekeeps whole imports", () => {
    assert.throws(() => assertImportShape({ app: "other" }), (e) => e.code === "wrong_app");
    assert.throws(() => assertImportShape({ app: "task-timer", version: 2 }), (e) => e.code === "newer_version");
    assert.throws(() => assertImportShape({ app: "task-timer", version: 1, tasks: "x" }), ImportError);

    const ok = assertImportShape({
        app: "task-timer",
        version: 1,
        tasks: [],
        sessions: [{ status: "running", segments: [{ start: 1, end: null }] }],
        events: [],
        settings: {},
    });
    assert.equal(ok, true);
});