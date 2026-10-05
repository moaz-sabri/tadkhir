import { ValidationError, ImportError } from "./errors.js";
import { DEFAULT_CURRENCY } from "./money.js";
import {
    ATTACHMENT_KINDS,
    MAX_ATTACHMENT_NAME,
    MAX_ATTACHMENTS_PER_NOTE,
    MAX_MEDIA_BYTES,
    MAX_PHOTO_BYTES,
    MAX_PHOTOS_PER_NOTE,
    MAX_VIDEO_BYTES,
    MAX_VIDEO_MS,
    MAX_AUDIO_MS,
    MAX_DOCUMENT_BYTES,
    MIN_AUDIO_MS,
    attachmentList,
    bytesOf
} from "./attachments.js";

export const MIN_ESTIMATE = 60000;
// 72 h is the hard ceiling for a single task estimate and a single session.
// In minutes that's 72 * 60 = 4320.
export const MAX_ESTIMATE = 72 * 60 * 60 * 1000;
export const MAX_DURATION_MS = MAX_ESTIMATE;
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

export const MAX_TITLE = 120;
export const MAX_NOTE = 2000;
export const MAX_SUBTASK_TITLE = 120;
export const MAX_ITEM_TITLE = 120;
export const MAX_SUBTASKS = 25;
export const MAX_SESSION_ITEMS = 25;

// Planner window: a plannedAt far in the past or future is almost certainly a
// typo or a device-clock problem. Allow no older than 1 year and no further
// than 2 years ahead.
export const MAX_PLANNED_PAST_MS = 365 * 24 * 60 * 60 * 1000;
export const MAX_PLANNED_FUTURE_MS = 2 * 365 * 24 * 60 * 60 * 1000;

export function plannedAtIsValid(plannedAt, now = Date.now()) {
    if (!Number.isInteger(plannedAt) || plannedAt <= 0) return false;
    return plannedAt <= now + MAX_PLANNED_FUTURE_MS && plannedAt >= now - MAX_PLANNED_PAST_MS;
}

// Per-space (per-account) quotas. Deleting records is the only way to free a
// slot ظ¤ archiving a task keeps counting toward the task quota.
export const MAX_TASKS = 100;
export const MAX_SESSIONS = 500;

// ---- Kanban ------------------------------------------------------------
// A reference layer, not a second copy. A card holds a pointer to a record some
// other service owns, plus the board's own bookkeeping (which column, which
// position, which day). Nothing is ever written back through this layer: the
// task is still the task, and the note is still the note. That is what lets the
// board be a view over the whole app without any of it becoming the app's
// second source of truth.
//
// `originalKey` is "service:id", and it is UNIQUE. Two devices adding the same
// task to their own board produce the same key, so the second one finds the first
// rather than making a twin — and the same key is how a delete finds the cards
// pointing at a record that has just been deleted, which is the only way the
// board can be sure it never shows a card whose original is gone.
export const MAX_KANBAN_ITEMS = 1000;

// The four columns, and only these four. See domain/kanban.js for why there is
// no fifth.
export const KANBAN_STATUSES = ["have", "working", "done", "deferred"];

// Which services may be pointed at. A closed list on purpose: it is the set of
// things that have a detail screen to open, and a card that cannot be opened is
// a card the user cannot act on.
export const KANBAN_SERVICES = ["tasks", "later", "pages"];

// A day key is exactly ten characters: four digits, a dash, two, a dash, two.
// Deliberately not `Date#toDateString()`, which is locale-dependent and would
// write a different string for the same day depending on the device's language.
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

// A key is an identifier, never prose, so it is trimmed and bounded but not
// line-broken and not emptied: a key with a newline in it would still match its
// own index while never matching what a reader sees.
function keyPart(raw, max) {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text || text.length > max) return null;
    return text;
}

/**
 * Normalises and checks one card's input.
 *
 * Three things are worth saying about the shape:
 *
 *   1. The service is DERIVED from `originalKey`, not read separately. Accepting
 *      both `service` and `originalKey` as independent inputs would let a card
 *      claim it points at a task while its key says it points at a note, and the
 *      two answers are both used to open it.
 *   2. Only the fields the caller actually supplied come back. A caller that
 *      sends `{ status }` must not have `dueAt` and `todayKey` reset to null
 *      by validation, so absent keys are absent from the result rather than
 *      present-and-empty.
 *   3. `originalData` is a label cache for drawing the card. It is passed
 *      through, and its id must agree with the key when it carries one, so a card
 *      cannot be labelled with one record's text and point at another's page.
 */
export function validateKanbanItemInput(input) {
    const x = input || {};
    const out = {};

    const key = keyPart(x.originalKey, MAX_ITEM_TITLE + 64) ||
        (x.service && x.originalId ? `${keyPart(x.service, 40)}:${keyPart(x.originalId, 120)}` : null);
    if (!key) throw new ValidationError("originalKey", "required");

    const colon = key.indexOf(":");
    if (colon < 1 || colon === key.length - 1) {
        throw new ValidationError("originalKey", "invalid_type");
    }
    const service = key.slice(0, colon);
    const originalId = key.slice(colon + 1);
    if (!KANBAN_SERVICES.includes(service)) {
        throw new ValidationError("service", "invalid_type");
    }

    // A snapshot that disagrees with the key is a record that would be drawn
    // with words from somewhere else. Refuse it rather than draw the mismatch.
    if (x.originalData?.id && String(x.originalData.id) !== originalId) {
        throw new ValidationError("originalData", "invalid_type");
    }

    out.originalKey = key;
    out.service = service;
    out.originalId = originalId;

    if (x.status !== undefined && x.status !== null) {
        if (!KANBAN_STATUSES.includes(x.status)) {
            throw new ValidationError("status", "invalid_type");
        }
        out.status = x.status;
    }

    if (x.order !== undefined && x.order !== null) {
        if (!Number.isInteger(x.order) || x.order < 0) {
            throw new ValidationError("order", "invalid_type");
        }
        out.order = x.order;
    }

    if (x.dueAt !== undefined) {
        if (x.dueAt !== null && (!Number.isInteger(x.dueAt) || x.dueAt <= 0)) {
            throw new ValidationError("dueAt", "invalid_type");
        }
        out.dueAt = x.dueAt;
    }

    if (x.todayKey !== undefined && x.todayKey !== null) {
        if (typeof x.todayKey !== "string" || !DAY_KEY.test(x.todayKey)) {
            throw new ValidationError("todayKey", "invalid_type");
        }
        out.todayKey = x.todayKey;
    }

    if (x.originalData !== undefined) {
        if (x.originalData !== null && typeof x.originalData !== "object") {
            throw new ValidationError("originalData", "invalid_type");
        }
        out.originalData = x.originalData;
    }

    if (x.meta !== undefined) {
        if (x.meta !== null && typeof x.meta !== "object") {
            throw new ValidationError("meta", "invalid_type");
        }
        out.meta = x.meta;
    }

    return out;
}

/**
 * A whole board, for an import or a restored backup.
 *
 * Every card is checked, and the uniqueness of `originalKey` is checked across
 * the SET rather than per record — a backup that points two cards at one task is
 * a backup that would import as a board with a duplicate that then fails to save
 * on the first move, which is a much worse place to find out.
 */
export function assertKanbanRecords(records) {
    if (!Array.isArray(records)) {
        throw new ImportError("kanbanItems", "invalid_type");
    }
    if (records.length > MAX_KANBAN_ITEMS) {
        throw new ImportError("kanbanItems", "too_many");
    }
    const seen = new Set();
    for (const record of records) {
        if (!record || typeof record !== "object") {
            throw new ImportError("kanbanItems", "invalid_type");
        }
        const { originalKey } = validateKanbanItemInput(record);
        if (seen.has(originalKey)) {
            throw new ImportError("kanbanItems", "broken_reference");
        }
        seen.add(originalKey);
    }
    return records;
}


// ---- Routines --------------------------------------------------------------
// A routine is a RULE the user writes once and then keeps: "run for 30 minutes,
// every day", "wash the car on Friday", "five cups of water". It is not a task,
// it is not a session, and it holds no history — what actually happened is
// recorded by the records that already existed (a session for a timed routine, a
// day of tallying for a counter), so nothing here can drift away from them.
//
// Two kinds and two frequencies, and no matrix of special cases between them:
//   timed    — has a length in minutes and is run by the app's own timer, which
//              is why it is "timed": the session it starts carries the routine's
//              duration as its estimate, so the existing countdown and the
//              existing end-of-estimate alert both work with nothing added.
//   counter  — a number to press, and the only kind that writes anything of its
//              own (one row per day). It creates no task and no session.
//   daily    — due every day.
//   weekly   — due on one weekday, chosen by the user, and only that day.
//
// The duration is OPTIONAL even for a timed routine, because a time that is not
// binding is the point: the user starts the run when they want to. A routine with
// no duration still appears on its day and still records the run; it just does not
// put a countdown on it.
export const ROUTINE_KINDS = ["timed", "counter"];
export const ROUTINE_FREQUENCIES = ["daily", "weekly"];

// Reminders. null = none. Both are offsets/periods in milliseconds from a CLOSED
// list, exactly like FINANCE_REMINDER_DAYS, for the same reason: the app has no
// push server and no scheduler, so a stored reminder is something the user SETS
// and can then READ BACK — a free-text hour would be a promise the app cannot
// keep dressed up as a number nobody checks. Which of the two applies is the
// caller's choice (a weekly routine is remembered "before the day", a counter
// "every hour"), and both are validated whenever they are present so a record
// arriving from sync cannot carry a period no screen can render.
export const ROUTINE_REMINDER_BEFORE = [null, 3600000, 10800000, 43200000, 86400000];
export const ROUTINE_REMINDER_EVERY = [null, 1800000, 3600000, 7200000, 14400000];

// Per-account quotas, both checked inside the write transaction like every other
// record's (see guardQuota). 100 rules is far more than anybody repeats, and the
// day rows are capped by history rather than by discipline: one per routine per
// day, so the ceiling is what a few routines over a few years add up to.
export const MAX_ROUTINES = 100;
export const MAX_ROUTINE_LOGS = 5000;

// How many cups of water. A number somebody presses on a phone is not going to
// be a million, and the ceiling is what stops a corrupted or hostile record from
// turning the reports into arithmetic nobody can read.
export const MAX_ROUTINE_TARGET = 999;
export const MAX_ROUTINE_COUNT = 1000;

/**
 * Normalises and checks one routine.
 *
 * The kind decides which body is required, so it is read first — the same order
 * the Later form and the page item form work in. A counter needs a target (there
 * is no "3 / ?" to show), a timed routine may have a duration and needs nothing
 * else. Fields that do not belong to the kind are CLEARED rather than kept: a
 * routine switched from counter to timed must not carry a target into the record
 * that says it is timed, or the row would claim two shapes at once.
 */
export function validateRoutineInput(x) {
    if (!ROUTINE_KINDS.includes(x?.kind)) {
        throw new ValidationError("kind", "invalid_type");
    }
    if (!ROUTINE_FREQUENCIES.includes(x?.frequency)) {
        throw new ValidationError("frequency", "invalid_type");
    }
    const title = oneLineTitle(x.title, "title");
    if (!title) throw new ValidationError("title", "required");

    // A weekday is what makes a weekly routine weekly, so it is required there
    // and cleared everywhere else. `getDay()` is 0..6 with Sunday first, which is
    // the numbering this stores.
    let weekday = null;
    if (x.frequency === "weekly") {
        if (!Number.isInteger(x.weekday) || x.weekday < 0 || x.weekday > 6) {
            throw new ValidationError("weekday", "out_of_range");
        }
        weekday = x.weekday;
    } else if (x.weekday != null && x.weekday !== "") {
        throw new ValidationError("weekday", "invalid_type");
    }

    const timed = x.kind === "timed";
    let durationMs = null;
    if (timed && x.durationMs != null && x.durationMs !== "") {
        if (!Number.isInteger(x.durationMs)
            || x.durationMs < MIN_ESTIMATE
            || x.durationMs > MAX_ESTIMATE) {
            throw new ValidationError("durationMs", "out_of_range");
        }
        durationMs = x.durationMs;
    } else if (!timed && x.durationMs != null && x.durationMs !== "") {
        throw new ValidationError("durationMs", "invalid_type");
    }

    let target = null;
    if (!timed) {
        if (!Number.isInteger(x.target) || x.target < 1 || x.target > MAX_ROUTINE_TARGET) {
            throw new ValidationError("target", "out_of_range");
        }
        target = x.target;
    } else if (x.target != null && x.target !== "") {
        throw new ValidationError("target", "invalid_type");
    }

    const reminderBeforeMs = x.reminderBeforeMs ?? null;
    if (!ROUTINE_REMINDER_BEFORE.includes(reminderBeforeMs)) {
        throw new ValidationError("reminderBeforeMs", "invalid_type");
    }
    const reminderEveryMs = x.reminderEveryMs ?? null;
    if (!ROUTINE_REMINDER_EVERY.includes(reminderEveryMs)) {
        throw new ValidationError("reminderEveryMs", "invalid_type");
    }

    return {
        ...x,
        kind: x.kind,
        frequency: x.frequency,
        title,
        weekday,
        durationMs,
        target,
        reminderBeforeMs,
        reminderEveryMs,
        active: x.active !== false
    };
}

/**
 * A whole set of rules, for an import or a restored backup.
 *
 * The day rows are checked too, because a tally with no rule behind it is
 * something the app cannot show and the reports cannot place — and an import is
 * the one path where a record can arrive that no form would ever have produced.
 */
export function assertRoutineRecords(records) {
    const fail = field => { throw new ImportError("invalid_schema", field); };
    if (!Array.isArray(records.routines)) fail("routines");
    if (!Array.isArray(records.routineLogs)) fail("routineLogs");

    const isTs = x => Number.isInteger(x) && x > 0;
    for (const r of records.routines) {
        if (!r || typeof r !== "object" || typeof r.id !== "string" || !r.id) fail("routines");
        try { validateRoutineInput(r); }
        catch { fail("routines"); }
        if (!isTs(r.createdAt) || !isTs(r.updatedAt)) fail("routines");
    }
    for (const l of records.routineLogs) {
        if (!l || typeof l !== "object" || typeof l.id !== "string" || !l.id) fail("routineLogs");
        if (typeof l.routineId !== "string" || !l.routineId) fail("routineLogs");
        if (typeof l.dayKey !== "string" || !DAY_KEY.test(l.dayKey)) fail("routineLogs");
        if (!Number.isInteger(l.count) || l.count < 0 || l.count > MAX_ROUTINE_COUNT) fail("routineLogs");
        if (!isTs(l.updatedAt)) fail("routineLogs");
    }
    return true;
}


// ---- Finance -------------------------------------------------------------
// Built-in category NAMES, seeded by Migration 5. A category is nothing but its
// name: no hierarchy, no icon, no colour, no budget, no rules. Users may add
// their own (a category id is free text, so it can be written in any
// language), and these seven are the ones that exist on first use.
export const BUILTIN_FINANCE_CATEGORIES = ["home", "work", "car", "food", "health", "shopping", "other"];
// The category everything falls back to. It is also where a deleted category
// moves its records, so it can never be deleted itself.
export const DEFAULT_FINANCE_CATEGORY = "other";
export const FINANCE_TYPES = ["income", "expense"];
export const FINANCE_FREQUENCIES = ["daily", "weekly", "monthly"];
export const FINANCE_DEBT_DIRECTIONS = ["owed_by_me", "owed_to_me"];
// null = no reminder, 0 = on the due date, otherwise days before.
export const FINANCE_REMINDER_DAYS = [null, 0, 1, 3, 7];

// Hard ceiling for a single amount: 999,999,999 minor units (~10M in a
// two-decimal currency). Keeps every sum far inside Number.MAX_SAFE_INTEGER.
export const MAX_FINANCE_AMOUNT = 999_999_999;
export const MAX_FINANCE_AMOUNT_SUM = 9_000_000_000_000;

export const MAX_FINANCE_TRANSACTIONS = 2000;
export const MAX_FINANCE_RECURRING = 200;
export const MAX_FINANCE_DEBTS = 500;
export const MAX_FINANCE_DEBT_PAYMENTS = 5000;
// A vocabulary, not a log: a few dozen categories and a couple of hundred
// people are far more than anyone types by hand, and both are tiny to store.
export const MAX_FINANCE_CATEGORIES = 60;
export const MAX_FINANCE_PEOPLE = 200;

// A date the user typed: a real timestamp, not a typo, and not absurdly far
// from now. Same intent as plannedAtIsValid, with the same 1y/2y window.
export function financeDateIsValid(at, now = Date.now()) {
    if (!Number.isInteger(at) || at <= 0) return false;
    return at <= now + MAX_PLANNED_FUTURE_MS && at >= now - MAX_PLANNED_PAST_MS;
}

function validateFinanceTitle(x) {
    if (typeof x?.title !== "string") {
        throw new ValidationError("title", "invalid_type");
    }
    const title = x.title.trim();
    if (!title) {
        throw new ValidationError("title", "required");
    }
    if (title.length > MAX_TITLE) {
        throw new ValidationError("title", "too_long");
    }
    return title;
}

function validateFinanceNote(x) {
    if (x.note != null && typeof x.note !== "string") {
        throw new ValidationError("note", "invalid_type");
    }
    if ((x.note ?? "").length > MAX_NOTE) {
        throw new ValidationError("note", "too_long");
    }
    return x.note?.trim() || null;
}

function validateFinanceAmount(x) {
    // Integer minor units only ظ¤ a float here would mean money drifted.
    if (!Number.isInteger(x.amount) || x.amount <= 0) {
        throw new ValidationError("amount", "out_of_range");
    }
    if (x.amount > MAX_FINANCE_AMOUNT) {
        throw new ValidationError("amount", "out_of_range");
    }
    return x.amount;
}

function validateFinanceType(x) {
    if (!FINANCE_TYPES.includes(x.type)) {
        throw new ValidationError("type", "invalid_type");
    }
    return x.type;
}

// A category id IS its display name, so the only rules are the ones any label
// must satisfy: non-empty after trimming, short enough to display, and free of
// control characters (a newline would break an <option> label). Existence is
// not checked here ظ¤ this module is pure and has no store to ask; the service
// resolves the id against the categories table.
export function validateCategoryInput(x) {
    if (typeof x !== "string") {
        throw new ValidationError("id", "invalid_type");
    }
    const id = x.trim();
    if (!id) {
        throw new ValidationError("id", "required");
    }
    if (id.length > MAX_TITLE) {
        throw new ValidationError("id", "too_long");
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(id)) {
        throw new ValidationError("id", "invalid_type");
    }
    return id;
}

// A person is a name plus an optional note. No type, no balance: whether they
// are a debtor or a creditor is decided by each debt, never stored on them.
export function validatePersonInput(x) {
    if (typeof x?.name !== "string") {
        throw new ValidationError("name", "invalid_type");
    }
    const name = x.name.trim();
    if (!name) {
        throw new ValidationError("name", "required");
    }
    if (name.length > MAX_TITLE) {
        throw new ValidationError("name", "too_long");
    }
    if (x.note != null && typeof x.note !== "string") {
        throw new ValidationError("note", "invalid_type");
    }
    if ((x.note ?? "").length > MAX_NOTE) {
        throw new ValidationError("note", "too_long");
    }
    return { name, note: x.note?.trim() || null };
}

function validateFinanceCategory(x) {
    if (x.category == null || x.category === "") return null;
    return validateCategoryInput(x.category);
}

function validateFinanceCurrency(x) {
    const currency = x.currency == null || x.currency === "" ? DEFAULT_CURRENCY : x.currency;
    if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
        throw new ValidationError("currency", "invalid_type");
    }
    return currency;
}

// Reports the offending field by name, so a form can point at the right input
// ("anchorAt" for a recurring rule, "occurredAt" for a transaction).
function validateFinanceDate(value, field, now = Date.now()) {
    if (!financeDateIsValid(value, now)) {
        throw new ValidationError(field, "out_of_range");
    }
    return value;
}

export function validateFinanceTransactionInput(x, now = Date.now()) {
    return {
        ...x,
        type: validateFinanceType(x),
        title: validateFinanceTitle(x),
        amount: validateFinanceAmount(x),
        currency: validateFinanceCurrency(x),
        category: validateFinanceCategory(x),
        occurredAt: validateFinanceDate(x.occurredAt, "occurredAt", now),
        note: validateFinanceNote(x),
        // Set when the transaction was produced by paying a recurring item.
        recurringId: typeof x.recurringId === "string" && x.recurringId ? x.recurringId : null
    };
}

export function validateFinanceRecurringInput(x, now = Date.now()) {
    if (!FINANCE_FREQUENCIES.includes(x.frequency)) {
        throw new ValidationError("frequency", "invalid_type");
    }
    const reminderDays = x.reminderDays ?? null;
    if (!FINANCE_REMINDER_DAYS.includes(reminderDays)) {
        throw new ValidationError("reminderDays", "invalid_type");
    }
    const anchorAt = validateFinanceDate(x.anchorAt, "anchorAt", now);
    return {
        ...x,
        type: validateFinanceType(x),
        title: validateFinanceTitle(x),
        amount: validateFinanceAmount(x),
        currency: validateFinanceCurrency(x),
        category: validateFinanceCategory(x),
        frequency: x.frequency,
        anchorAt,
        reminderDays,
        note: validateFinanceNote(x),
        active: x.active !== false
    };
}

export function validateFinanceDebtInput(x, now = Date.now()) {
    if (!FINANCE_DEBT_DIRECTIONS.includes(x.direction)) {
        throw new ValidationError("direction", "invalid_type");
    }
    if (x.dueAt != null && !financeDateIsValid(x.dueAt, now)) {
        throw new ValidationError("dueAt", "out_of_range");
    }
    return {
        ...x,
        direction: x.direction,
        title: validateFinanceTitle(x),
        // The name is a snapshot of the person at save time (same idea as
        // session.taskTitle): a debt still reads correctly if the person is
        // later removed. personId is the live link used to group debts.
        personId: typeof x.personId === "string" && x.personId ? x.personId : null,
        person: typeof x.person === "string" ? x.person.trim().slice(0, MAX_TITLE) || null : null,
        amount: validateFinanceAmount(x),
        currency: validateFinanceCurrency(x),
        category: validateFinanceCategory(x),
        dueAt: x.dueAt ?? null,
        note: validateFinanceNote(x)
    };
}

export function validateFinanceDebtPaymentInput(x, now = Date.now()) {
    if (typeof x?.debtId !== "string" || !x.debtId) {
        throw new ValidationError("debtId", "invalid_type");
    }
    if (x.title != null && typeof x.title !== "string") {
        throw new ValidationError("title", "invalid_type");
    }
    if ((x.title ?? "").length > MAX_TITLE) {
        throw new ValidationError("title", "too_long");
    }
    return {
        ...x,
        debtId: x.debtId,
        title: x.title?.trim() || null,
        amount: validateFinanceAmount(x),
        occurredAt: validateFinanceDate(x.occurredAt, "occurredAt", now),
        note: validateFinanceNote(x)
    };
}

// Records arriving from sync or an import are not fresh user input: they are
// historical, so the "not absurdly far from now" window does not apply to
// them. Only the structural invariants that the rest of the app relies on are
// checked here, reported as ImportError.
export function assertFinanceRecords(records) {
    const fail = field => { throw new ImportError("invalid_schema", field); };

    const isMinorAmount = x => Number.isInteger(x) && x > 0 && x <= MAX_FINANCE_AMOUNT;
    const isTs = x => Number.isInteger(x) && x > 0;
    const isOptionalText = x => x == null || typeof x === "string";
    // Categories are free-text names now, so only the shape is checked here.
    // Whether the name still exists is a question for the app, not the format.
    const isCategory = x => {
        if (x == null) return true;
        if (typeof x !== "string") return false;
        const id = x.trim();
        return !!id && id.length <= MAX_TITLE && !/[\u0000-\u001f\u007f]/.test(id);
    };
    const isCurrency = x => typeof x === "string" && /^[A-Z]{3}$/.test(x);
    // A transaction, rule and debt must be identifiable by their title. A debt
    // payment inherits its debt's name, so its own title is optional and a
    // payment with title: null must survive an export/import round trip.
    const isTitle = (x, required) => {
        if (x == null) return !required;
        if (typeof x !== "string" || x.length > MAX_TITLE) return false;
        return !required || !!x.trim();
    };

    const check = (list, fn, field, { titleRequired = true } = {}) => {
        if (!Array.isArray(list)) fail(field);
        for (const r of list) {
            if (!r || typeof r !== "object" || typeof r.id !== "string" || !r.id) fail(field);
            if (!isTitle(r.title, titleRequired)) fail(field);
            if (!isOptionalText(r.note) || (r.note ?? "").length > MAX_NOTE) fail(field);
            fn(r);
        }
    };

    check(records.transactions, r => {
        if (!FINANCE_TYPES.includes(r.type) || !isMinorAmount(r.amount)) fail("financeTransactions");
        if (!isCurrency(r.currency) || !isCategory(r.category) || !isTs(r.occurredAt)) fail("financeTransactions");
    }, "financeTransactions");

    check(records.recurring, r => {
        if (!FINANCE_TYPES.includes(r.type) || !isMinorAmount(r.amount)) fail("financeRecurring");
        if (!isCurrency(r.currency) || !isCategory(r.category) || !isTs(r.anchorAt)) fail("financeRecurring");
        if (!FINANCE_FREQUENCIES.includes(r.frequency) || !FINANCE_REMINDER_DAYS.includes(r.reminderDays ?? null)) {
            fail("financeRecurring");
        }
        if (r.skipped != null && (!Array.isArray(r.skipped) || r.skipped.some(x => !isTs(x)))) {
            fail("financeRecurring");
        }
    }, "financeRecurring");

    check(records.debts, r => {
        if (!FINANCE_DEBT_DIRECTIONS.includes(r.direction) || !isMinorAmount(r.amount)) fail("financeDebts");
        if (!isCurrency(r.currency) || !isCategory(r.category)) fail("financeDebts");
        if (r.dueAt != null && !isTs(r.dueAt)) fail("financeDebts");
    }, "financeDebts");

    check(records.debtPayments, r => {
        if (typeof r.debtId !== "string" || !r.debtId) fail("financeDebtPayments");
        if (!isMinorAmount(r.amount) || !isTs(r.occurredAt)) fail("financeDebtPayments");
    }, "financeDebtPayments", { titleRequired: false });

    // Categories are a list of names ظ¤ the id is the name. No `title` field,
    // so the shared title check does not apply to them.
    if (!Array.isArray(records.categories)) fail("financeCategories");
    for (const c of records.categories) {
        if (!c || typeof c !== "object" || !isCategory(c.id)) fail("financeCategories");
    }

    if (!Array.isArray(records.people)) fail("financePeople");
    for (const p of records.people) {
        if (!p || typeof p !== "object" || typeof p.id !== "string" || !p.id) fail("financePeople");
        if (!isTitle(p.name, true)) fail("financePeople");
        if (!isOptionalText(p.note) || (p.note ?? "").length > MAX_NOTE) fail("financePeople");
    }

    return true;
}

// ---- Later ----------------------------------------------------------------
// Later is deliberately the smallest record in the app: one link or one note
// the user wants to come back to. Two types, an optional title, the text, the
// link and a single stamp that says it was followed up. No tags, no folders, no
// priority, no due date, and no relation to a task or a session ظ¤ it is a
// holding pen of its own.
export const LATER_TYPES = ["link", "note"];

// A per-account quota like tasks and finance records: deleting is the only way
// to free a slot. 500 is far more than anyone keeps "for later".
export const MAX_LATER_ITEMS = 500;

// Long enough for any real link, short enough that a pasted data: URI cannot
// turn a record into a payload.
export const MAX_LATER_URL = 2000;

// Only http(s) may be stored, so a shared "javascript:" or "data:" string can
// never end up in an href. Used on records that arrive from a sync or an import,
// where the value is already normalized and only its shape is checked.
function isHttpUrl(x) {
    if (typeof x !== "string" || !x || x.length > MAX_LATER_URL) return false;
    try {
        const parsed = new URL(x);
        return (parsed.protocol === "http:" || parsed.protocol === "https:") && !!parsed.hostname;
    } catch {
        return false;
    }
}

// A title that labels a list row, or the heading of a page. One line: a newline
// or a control character in it would break the row it is supposed to name. Two
// features need this exact rule and they must not each grow their own copy, so
// it is stated once here and both delegate to it.
export function oneLineTitle(raw, field = "title") {
    if (raw != null && typeof raw !== "string") {
        throw new ValidationError(field, "invalid_type");
    }
    const title = (raw ?? "").trim();
    if (title.length > MAX_TITLE) {
        throw new ValidationError(field, "too_long");
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(title)) {
        throw new ValidationError(field, "invalid_type");
    }
    return title || null;
}

// One line: the title is the label of a list row, and a newline in it would
// break the row. Same rule as a category name, and the same function.
function validateLaterTitle(raw) {
    return oneLineTitle(raw);
}

// A note is its text OR its attachments, so it cannot be empty in both. A link
// may carry a line about why it was saved, so its text is optional, and a link
// with a picture on it is a link first ظ¤ the url is what the row opens.
function validateLaterContent(raw, type) {
    if (raw != null && typeof raw !== "string") {
        throw new ValidationError("content", "invalid_type");
    }
    const content = (raw ?? "").trim();
    if (content.length > MAX_NOTE) {
        throw new ValidationError("content", "too_long");
    }
    return content || null;
}

// Normalized on the way in, so every stored link is absolute and openable
// without the UI having to guess: a bare host ("example.com/x") gets the
// https:// it was missing, and anything that is not http(s) is refused.
function validateLaterUrl(raw) {
    if (raw != null && typeof raw !== "string") {
        throw new ValidationError("url", "invalid_type");
    }
    const value = (raw ?? "").trim();
    if (!value) {
        throw new ValidationError("url", "required");
    }
    if (value.length > MAX_LATER_URL) {
        throw new ValidationError("url", "too_long");
    }
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) ? value : `https://${value}`;
    let parsed;
    try {
        parsed = new URL(withScheme);
    } catch {
        throw new ValidationError("url", "invalid_type");
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
        throw new ValidationError("url", "invalid_type");
    }
    return parsed.href;
}

// The type decides which of the two bodies is required, so it is read first:
// a link needs a url, a note never carries a url (which is what makes "switch
// this link to a note" work without a second field), and a note needs either
// text or an attachment ظ¤ a note that is three photographs and no words is a
// note, and refusing it would mean the recorder could not be the first thing
// the user did.
export function validateLaterInput(x) {
    if (!LATER_TYPES.includes(x?.type)) {
        throw new ValidationError("type", "invalid_type");
    }
    const content = validateLaterContent(x.content, x.type);
    const attachments = validateAttachments(x.attachments);
    if (x.type === "note" && !content && !attachments.length) {
        throw new ValidationError("content", "required");
    }
    return {
        ...x,
        type: x.type,
        title: validateLaterTitle(x.title),
        content,
        attachments,
        url: x.type === "link" ? validateLaterUrl(x.url) : null
    };
}

// One attachment description, on its own. Also the building block of the array
// rule below, so a description arriving from sync and one arriving from the form
// are checked by exactly the same function.
//
// The rules are the per-kind ones from domain/attachments.js, and each code
// names WHICH limit was hit rather than a single "too large": "this video is
// longer than 30 seconds" and "this document is bigger than 3 MB" are different
// sentences, and a user told only "too large" re-tries the same file.
function validateAttachment(x) {
    if (x == null || typeof x !== "object" || Array.isArray(x)) {
        throw new ValidationError("attachments", "invalid_type");
    }
    if (typeof x.id !== "string" || !x.id || x.id.length > 128) {
        throw new ValidationError("attachments", "invalid_type");
    }
    if (!ATTACHMENT_KINDS.includes(x.kind)) {
        throw new ValidationError("attachments", "attachment_kind");
    }
    if (typeof x.name !== "string" || !x.name.trim() || x.name.length > MAX_ATTACHMENT_NAME) {
        throw new ValidationError("attachments", "invalid_type");
    }
    if (x.type != null
        && (typeof x.type !== "string" || x.type.length > 200 || /[\u0000-\u001f\u007f]/.test(x.type))) {
        throw new ValidationError("attachments", "invalid_type");
    }
    if (!Number.isInteger(x.size) || x.size < 0) {
        throw new ValidationError("attachments", "invalid_type");
    }

    // A duration is measured by the app for a recording and read out of the file
    // for a picked one ظ¤ either way it is a number the app will not take on
    // trust from a record it did not write.
    const durationMs = x.durationMs ?? null;
    if (durationMs != null && (!Number.isInteger(durationMs) || durationMs < 0)) {
        throw new ValidationError("attachments", "invalid_type");
    }
    if (x.kind === "audio" && durationMs != null && durationMs < MIN_AUDIO_MS) {
        throw new ValidationError("attachments", "audio_too_short");
    }
    if (x.kind === "audio" && durationMs != null && durationMs > MAX_AUDIO_MS) {
        throw new ValidationError("attachments", "audio_too_long");
    }
    if (x.kind === "video" && durationMs != null && durationMs > MAX_VIDEO_MS) {
        throw new ValidationError("attachments", "video_too_long");
    }
    if (x.kind === "photo" && x.size > MAX_PHOTO_BYTES) {
        throw new ValidationError("attachments", "photo_too_large");
    }
    if (x.kind === "video" && x.size > MAX_VIDEO_BYTES) {
        throw new ValidationError("attachments", "video_too_large");
    }
    if (x.kind === "document" && x.size > MAX_DOCUMENT_BYTES) {
        throw new ValidationError("attachments", "document_too_large");
    }
    return {
        id: x.id,
        kind: x.kind,
        name: x.name,
        type: x.type ?? null,
        size: x.size,
        durationMs,
        width: Number.isInteger(x.width) && x.width > 0 ? x.width : null,
        height: Number.isInteger(x.height) && x.height > 0 ? x.height : null,
        createdAt: x.createdAt
    };
}

// The whole set on one note, in the order the domain module reads it. Three
// ceilings that are about the NOTE rather than about a file: how many things it
// may carry, how many of them may be photographs, and how many bytes they may
// add up to. The per-file ceilings are checked above, one file at a time.
export function validateAttachments(raw) {
    if (raw == null) return [];
    if (!Array.isArray(raw)) {
        throw new ValidationError("attachments", "invalid_type");
    }
    if (raw.length > MAX_ATTACHMENTS_PER_NOTE) {
        throw new ValidationError("attachments", "attachments_limit");
    }
    const list = raw.map(validateAttachment);
    if (list.filter(x => x.kind === "photo").length > MAX_PHOTOS_PER_NOTE) {
        throw new ValidationError("attachments", "photos_limit");
    }
    if (bytesOf(list) > MAX_MEDIA_BYTES) {
        throw new ValidationError("attachments", "attachments_too_large");
    }
    return attachmentList({ attachments: list });
}

// Records arriving from sync or an import are not fresh user input: the "not
// absurdly far from now" window does not apply to them, only the structural
// invariants the rest of the app relies on. completedAt is checked when present
// (null on every item that has not been followed up yet).
export function assertLaterRecords(records) {
    const fail = () => { throw new ImportError("invalid_schema", "later"); };
    if (!Array.isArray(records)) fail();
    const isTs = x => Number.isInteger(x) && x > 0;
    for (const r of records) {
        if (!r || typeof r !== "object" || typeof r.id !== "string" || !r.id) fail();
        if (!LATER_TYPES.includes(r.type)) fail();
        if (r.title != null && (typeof r.title !== "string" || r.title.length > MAX_TITLE)) fail();
        if (r.content != null && (typeof r.content !== "string" || r.content.length > MAX_NOTE)) fail();
        // An item written before attachments existed has no field at all, which
        // is not a failure ظ¤ it is the same record with nothing attached. A
        // record that DOES carry them is checked by the same validator the form
        // is checked by, so a hostile payload cannot put a 400 MB "photo" into a
        // backup that a restore would then try to describe.
        let attachments = [];
        if (r.attachments !== undefined) {
            try {
                attachments = validateAttachments(r.attachments);
            } catch {
                fail();
            }
        }
        if (r.type === "note") {
            if (r.url != null) fail();
            // A note needs text OR an attachment, on the same terms as the form.
            // `null` content is a real state now ظ¤ it is what a note that is only
            // photographs stores ظ¤ so it is accepted where it used to be a type
            // failure, and the emptiness check below is what still refuses an
            // empty note.
            if (r.content !== null && typeof r.content !== "string") fail();
            if (!String(r.content ?? "").trim() && !attachments.length) fail();
        } else if (!isHttpUrl(r.url)) {
            fail();
        }
        if (!isTs(r.createdAt) || !isTs(r.updatedAt)) fail();
        if (r.completedAt != null && !isTs(r.completedAt)) fail();
    }
    return true;
}

// ---- Pages -----------------------------------------------------------------
// A page is an organisation layer over records that already exist: in the order
// the user chose, a list of headings, paragraphs, dividers and POINTERS at tasks,
// sessions, Later items and money records. Seven kinds, no more, and none of them
// copies anything ظ¤ an item that points at a task holds that task's id and
// nothing else.
//
// The split from Later is the point of the feature. Later is a holding pen of
// its own with no relation to a task or a session; a page is the opposite: it
// holds nothing of its own except words, and everything else it shows is read
// from the service that owns the original. So a page never becomes a second
// place a task can be edited, never a stale copy, and never a fifth record type
// the other features have to know about.
export const PAGE_ITEM_TYPES = [
    "text", "heading", "divider", "task", "session", "reference", "expense"
];

// Which field inside `content` holds the id of the record an item points at,
// per linked kind. ONE table, because three readers have to agree about it: this
// validator (which field is required), the domain module (which id the item
// carries) and the picker (what to write when the user chooses a record). Three
// hand-written copies of the same map is the kind of drift that shows up as
// "the link opened the wrong screen".
//
// The names say what they point at, not what they are called: `reference` points
// at a Later item, and `expense` points at a money record in either direction ظ¤
// so neither name is a promise about a direction the app does not have.
export const PAGE_ITEM_TARGETS = Object.freeze({
    task: "taskId",
    session: "sessionId",
    reference: "laterId",
    expense: "transactionId"
});

// Per-account quotas, both checked inside the write transaction like every other
// record's (see guardQuota). 100 pages is far more than anyone keeps filed, and
// 1000 items is the most one page may hold: a page that long is not a page, and
// the cap is what keeps "reorder everything" and "sync the whole page" bounded.
export const MAX_PAGES = 100;
export const MAX_PAGE_ITEMS = 1000;

// A paragraph on a page. Longer than a note, because a page is the one place in
// the app where prose belongs ظ¤ but still bounded, so a pasted document cannot
// turn a record into a payload.
export const MAX_PAGE_TEXT = 4000;

// The page itself: a title that is always optional (a page is created untitled
// and named afterwards, so "no title yet" is a real state and the list shows a
// fallback label) and a description reusing the note limit.
export function validatePageInput(x) {
    if (x == null || typeof x !== "object") {
        throw new ValidationError("title", "invalid_type");
    }
    if (x.description != null && typeof x.description !== "string") {
        throw new ValidationError("description", "invalid_type");
    }
    if ((x.description ?? "").length > MAX_NOTE) {
        throw new ValidationError("description", "too_long");
    }
    return {
        ...x,
        title: oneLineTitle(x.title),
        description: x.description?.trim() || null
    };
}

// One item, whatever kind it is. The kind is read first because it decides
// which body is required ظ¤ the same order the Later form and the transaction
// form work in.
export function validatePageItemInput(x) {
    if (!PAGE_ITEM_TYPES.includes(x?.type)) {
        throw new ValidationError("type", "invalid_type");
    }
    if (typeof x.pageId !== "string" || !x.pageId) {
        throw new ValidationError("pageId", "invalid_type");
    }
    // The position is the page's own order, and it is a gapless index rather
    // than a fractional one: two devices that reorder at the same moment
    // produce the same set of integers, and the reader always renumbers the
    // items that actually moved.
    if (x.position != null && (!Number.isInteger(x.position) || x.position < 0)) {
        throw new ValidationError("position", "out_of_range");
    }
    return {
        ...x,
        type: x.type,
        position: x.position ?? null,
        content: validatePageItemContent(x.content, x.type)
    };
}

// One body per kind, chosen by the kind ظ¤ so a divider never carries text, a
// paragraph is never asked for a record id, and switching a link from a task to
// a session cannot leave the old task's id behind pointing at something the row
// no longer claims to be.
//
// The id of a linked record is NOT checked for existence here. This module is
// pure and has no store to ask, and requiring the original to still be there
// would be wrong anyway: the record can be deleted on another device at any
// moment, and a pointer that refuses to survive that is not a pointer. The page
// screen resolves it and says so plainly when it is gone.
// The words of a heading, which must not wrap: a heading is a title in the middle
// of a document, so MAX_TITLE is generous for one and a newline in it would be
// two headings.
//
// It may be EMPTY, and that is deliberate: the editor creates a line and the user
// then types into it, so "not written yet" has to be a storable state ظ¤ exactly
// as it is for a paragraph, whose contents are removed by emptying it. A
// "required" rule on either would block every backspace.
function oneLineText(raw) {
    const text = raw ?? "";
    if (typeof text !== "string") {
        throw new ValidationError("content", "invalid_type");
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(text)) {
        throw new ValidationError("content", "invalid_type");
    }
    if (text.length > MAX_TITLE) {
        throw new ValidationError("content", "too_long");
    }
    return text.trim();
}

function validatePageItemContent(raw, type) {
    const target = PAGE_ITEM_TARGETS[type];
    if (target) {
        if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
            throw new ValidationError("content", "invalid_type");
        }
        const id = raw[target];
        if (typeof id !== "string" || !id) {
            throw new ValidationError("content", "required");
        }
        // An id is a uuid in practice; MAX_TITLE is a generous ceiling that
        // still refuses a pasted paragraph.
        if (id.length > MAX_TITLE) {
            throw new ValidationError("content", "too_long");
        }
        // Only the field this kind uses survives.
        return { [target]: id };
    }
    if (type === "divider") {
        return {};
    }
    const text = raw?.text;
    if (text != null && typeof text !== "string") {
        throw new ValidationError("content", "invalid_type");
    }
    if (type === "heading") {
        return { text: oneLineText(text) };
    }
    if ((text ?? "").length > MAX_PAGE_TEXT) {
        throw new ValidationError("content", "too_long");
    }
    return { text: (text ?? "").trim() };
}

// Records arriving from sync or an import are historical, so the "not absurdly
// far from now" window does not apply to them ظ¤ only the structural invariants
// the rest of the app relies on. Reported as ImportError, like every other
// record's.
export function assertPageRecords(records) {
    const fail = () => { throw new ImportError("invalid_schema", "pages"); };
    if (!Array.isArray(records)) fail();
    const isTs = x => Number.isInteger(x) && x > 0;
    for (const r of records) {
        if (!r || typeof r !== "object" || typeof r.id !== "string" || !r.id) fail();
        if (r.title != null && (typeof r.title !== "string" || r.title.length > MAX_TITLE)) fail();
        // eslint-disable-next-line no-control-regex
        if (r.title != null && /[\u0000-\u001f\u007f]/.test(r.title)) fail();
        if (r.description != null && (typeof r.description !== "string" || r.description.length > MAX_NOTE)) fail();
        if (!isTs(r.createdAt) || !isTs(r.updatedAt)) fail();
    }
    return true;
}

export function assertPageItemRecords(records) {
    const fail = () => { throw new ImportError("invalid_schema", "pageItems"); };
    if (!Array.isArray(records)) fail();
    const isTs = x => Number.isInteger(x) && x > 0;
    for (const r of records) {
        if (!r || typeof r !== "object" || typeof r.id !== "string" || !r.id) fail();
        if (typeof r.pageId !== "string" || !r.pageId) fail();
        if (!PAGE_ITEM_TYPES.includes(r.type)) fail();
        if (!Number.isInteger(r.position) || r.position < 0) fail();
        const c = r.content;
        if (!c || typeof c !== "object" || Array.isArray(c)) fail();
        // Exactly the keys the kind allows and no others. A carried-over id from
        // a previous kind is how a link would silently start pointing somewhere
        // the user never chose.
        const keys = Object.keys(c);
        const target = PAGE_ITEM_TARGETS[r.type];
        if (target) {
            if (keys.length !== 1 || keys[0] !== target) fail();
            if (typeof c[target] !== "string" || !c[target] || c[target].length > MAX_TITLE) fail();
        } else if (r.type === "divider") {
            if (keys.length !== 0) fail();
        } else {
            if (keys.length !== 1 || keys[0] !== "text") fail();
            if (typeof c.text !== "string") fail();
            // A heading is one line; a paragraph may be as long as a paragraph is
            // allowed to be. Both may be empty: the editor creates a line and the
            // user fills it in, so "not written yet" is a state to survive a
            // round trip.
            const max = r.type === "heading" ? MAX_TITLE : MAX_PAGE_TEXT;
            if (c.text.length > max) fail();
            // eslint-disable-next-line no-control-regex
            if (r.type === "heading" && /[\u0000-\u001f\u007f]/.test(c.text)) fail();
        }
        if (!isTs(r.createdAt) || !isTs(r.updatedAt)) fail();
    }
    return true;
}

// Subtask quota grows with the estimate: one subtask per minute of estimate,
// capped at MAX_SUBTASKS (e.g. 5 min -> 5 subtasks, 10 min -> 10, 25+ -> 25).
export function subtaskLimitForEstimate(estimatedMs) {
    if (!Number.isInteger(estimatedMs) || estimatedMs <= 0) return MAX_SUBTASKS;
    return Math.max(1, Math.min(MAX_SUBTASKS, Math.floor(estimatedMs / 60000)));
}

export function validateTaskInput(x) {
    if (typeof x?.title !== "string") {
        throw new ValidationError("title", "invalid_type");
    }
    const title = x.title.trim();
    if (!title) {
        throw new ValidationError("title", "required");
    }
    if (title.length > MAX_TITLE) {
        throw new ValidationError("title", "too_long");
    }
    if (!Number.isInteger(x.estimatedMs) || x.estimatedMs < MIN_ESTIMATE || x.estimatedMs > MAX_ESTIMATE) {
        throw new ValidationError("estimatedMs", "out_of_range");
    }
    if (x.note != null && typeof x.note !== "string") {
        throw new ValidationError("note", "invalid_type");
    }
    if ((x.note ?? "").length > MAX_NOTE) {
        throw new ValidationError("note", "too_long");
    }
    if (x.plannedAt != null && !plannedAtIsValid(x.plannedAt)) {
        throw new ValidationError("plannedAt", "out_of_range");
    }
    const subtasks = normalizeSubtasks(x.subtasks, subtaskLimitForEstimate(x.estimatedMs));
    return {
        ...x,
        title,
        note: x.note?.trim() || null,
        plannedAt: x.plannedAt ?? null,
        subtasks
    };
}

function normalizeSubtasks(value, cap) {
    if (value == null) return [];
    if (!Array.isArray(value)) {
        throw new ValidationError("subtasks", "invalid_type");
    }
    const seen = new Set();
    const out = [];
    for (const s of value) {
        if (typeof s?.title !== "string") {
            throw new ValidationError("subtasks", "invalid_type");
        }
        const title = s.title.trim();
        if (!title) continue;
        const id = typeof s.id === "string" && s.id ? s.id : crypto.randomUUID();
        if (seen.has(id)) continue;
        seen.add(id);
        if (out.length >= cap) {
            throw new ValidationError("subtasks", "too_many");
        }
        out.push({ id, title: title.slice(0, MAX_SUBTASK_TITLE) });
    }
    return out;
}

export function assertSessionInvariant(s) {
    if (!s || typeof s !== "object") {
        throw new ImportError("invalid_schema", "session");
    }
    if (!["running", "paused", "completed", "cancelled"].includes(s.status)) {
        throw new ImportError("invalid_schema", "status");
    }
    let lastEnd = -Infinity;
    for (const seg of s.segments || []) {
        if (!Number.isFinite(seg.start)) {
            throw new ImportError("invalid_schema", "segment_start");
        }
        if (seg.end != null && !Number.isFinite(seg.end)) {
            throw new ImportError("invalid_schema", "segment_end");
        }
        if (seg.end != null && seg.end < seg.start) {
            throw new ImportError("invalid_schema", "segment_order");
        }
        if (seg.start < lastEnd) {
            throw new ImportError("invalid_schema", "segment_overlap");
        }
        lastEnd = seg.end ?? seg.start;
    }
    const open = (s.segments || []).filter(x => x.end == null).length;
    if (s.status === "running" && open !== 1) {
        throw new ImportError("invalid_schema", "running_segment");
    }
    if (s.status !== "running" && open !== 0) {
        throw new ImportError("invalid_schema", "closed_segments");
    }
    if (["completed", "cancelled"].includes(s.status) && (s.endedAt == null || s.actualMs == null)) {
        throw new ImportError("invalid_schema", "ended_session");
    }
    // taskItems is optional (older backups lack it -> treated as []). When
    // present, every item must be a snapshot {id, title, completed}.
    if (s.taskItems != null) {
        if (!Array.isArray(s.taskItems)) {
            throw new ImportError("invalid_schema", "task_items");
        }
        for (const it of s.taskItems) {
            if (
                !it || typeof it !== "object"
                || typeof it.id !== "string"
                || typeof it.title !== "string"
                || typeof it.completed !== "boolean"
            ) {
                throw new ImportError("invalid_schema", "task_item");
            }
        }
    }
    // note is optional (older backups lack it). When present it must be a
    // string within the same length limit as task notes.
    if (s.note != null && (typeof s.note !== "string" || s.note.length > MAX_NOTE)) {
        throw new ImportError("invalid_schema", "session_note");
    }
    // routineId is optional, and only ever an id: a session that was started from
    // a routine carries which one, which is the whole link between the rule and
    // the run. Absent on every session that was not, which is every session that
    // existed before routines did. The routine it names is NOT checked for
    // existence — the same rule page items follow: the original can be deleted on
    // another device at any moment, and a link that refuses to survive that is
    // not a link.
    if (s.routineId != null
        && (typeof s.routineId !== "string" || !s.routineId || s.routineId.length > MAX_TITLE)) {
        throw new ImportError("invalid_schema", "session_routine");
    }
    return true;
}

// A task is the one record the whole app is built around, and it was the one
// record the import gate never looked at: a backup could carry a task with no
// id, a 5000-character title, a negative estimate or a `subtasks` value that
// was not an array, and all of it was written straight into a store keyed on
// `id`. The id-less case threw a raw DataError from IndexedDB that aborted the
// entire restore ظ¤ a bad task meant losing every good one with it. The other
// cases imported silently and were only ever a layout bug waiting to happen.
//
// The window check does not apply (same rule as finance and later: a record
// that arrives from a backup is historical), but the structural invariants the
// rest of the app relies on do.
export function assertTaskRecords(tasks) {
    const fail = field => { throw new ImportError("invalid_schema", field); };
    if (!Array.isArray(tasks)) fail("tasks");
    for (const t of tasks) {
        if (!t || typeof t !== "object") fail("tasks");
        if (typeof t.id !== "string" || !t.id) fail("tasks");
        if (typeof t.title !== "string" || !t.title.trim() || t.title.length > MAX_TITLE) fail("tasks");
        if (!Number.isInteger(t.estimatedMs) || t.estimatedMs < MIN_ESTIMATE || t.estimatedMs > MAX_ESTIMATE) fail("tasks");
        if (t.note != null && (typeof t.note !== "string" || t.note.length > MAX_NOTE)) fail("tasks");
        if (t.plannedAt != null && !Number.isInteger(t.plannedAt)) fail("tasks");
        if (t.subtasks != null) {
            if (!Array.isArray(t.subtasks)) fail("tasks");
            for (const s of t.subtasks) {
                if (!s || typeof s !== "object" || typeof s.id !== "string" || !s.id) fail("tasks");
                if (typeof s.title !== "string" || s.title.length > MAX_SUBTASK_TITLE) fail("tasks");
            }
        }
    }
    return true;
}

export function assertImportShape(data) {
    if (!data || typeof data !== "object") {
        throw new ImportError("invalid_schema");
    }
    if (data.app !== "task-timer") {
        throw new ImportError("wrong_app");
    }
    if (!Number.isInteger(data.version)) {
        throw new ImportError("invalid_schema");
    }
    if (data.version > 1) {
        throw new ImportError("newer_version");
    }
    for (const k of ["tasks", "sessions", "events", "settings"]) {
        if (!Array.isArray(data[k]) && k !== "settings") {
            throw new ImportError("invalid_schema");
        }
    }
    if (typeof data.settings !== "object" || data.settings === null) {
        throw new ImportError("invalid_schema");
    }
    data.sessions.forEach(assertSessionInvariant);
    assertTaskRecords(data.tasks);
    // Finance is additive: a v1 backup without these keys imports as empty
    // finance, and a v1 backup WITH them is still a v1 backup. The format
    // version is therefore unchanged. Categories and people are the same
    // story one step further along: missing means "use the defaults".
    if ([
        "financeTransactions", "financeRecurring", "financeDebts",
        "financeDebtPayments", "financeCategories", "financePeople"
    ].some(k => data[k] !== undefined)) {
        assertFinanceRecords({
            transactions: data.financeTransactions ?? [],
            recurring: data.financeRecurring ?? [],
            debts: data.financeDebts ?? [],
            debtPayments: data.financeDebtPayments ?? [],
            categories: data.financeCategories ?? BUILTIN_FINANCE_CATEGORIES.map(id => ({ id })),
            people: data.financePeople ?? []
        });
    }
    // Later is additive on the same terms: a backup written before it existed
    // imports with no Later items, and one that carries them is still a v1
    // backup, so the format version does not move.
    if (data.later !== undefined) {
        assertLaterRecords(data.later);
    }
    // Pages are additive on the same terms: a backup written before they existed
    // imports with none, and one that carries them is still a v1 backup, so the
    // format version does not move. Both keys are checked together, because half
    // a page ظ¤ items with no page to belong to ظ¤ is not a state anything can
    // render.
    if (data.pages !== undefined || data.pageItems !== undefined) {
        assertPageRecords(data.pages ?? []);
        assertPageItemRecords(data.pageItems ?? []);
    }
    // The board is additive on the same terms as everything else after it: a
    // backup written before it existed imports with an empty board, and one that
    // carries cards is still a v1 backup.
    if (data.kanbanItems !== undefined) {
        assertKanbanRecords(data.kanbanItems);
    }
    // Routines too, and the two keys are checked TOGETHER: a day of tallying with
    // no rule to belong to, or a rule with none of its days, are the two halves
    // of a set the app can store but cannot draw.
    if (data.routines !== undefined || data.routineLogs !== undefined) {
        assertRoutineRecords({
            routines: data.routines ?? [],
            routineLogs: data.routineLogs ?? []
        });
    }
    return true;
}
