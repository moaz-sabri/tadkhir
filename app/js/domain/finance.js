import { ValidationError, NotFoundError } from "./errors.js";
import { DAY_MS } from "./time.js";
import { DEFAULT_FINANCE_CATEGORY } from "./validation.js";

// Pure Finance domain logic. Imports nothing from data/, services/ or ui/ —
// every function here is a pure function over plain records, so the rules can
// be tested directly (same style as session-engine.js).
//
// Two deliberate choices shape this module:
//
//  1. A recurring item is a RULE (anchor date + frequency), never a pile of
//     future transactions. Its payment history is the set of transactions
//     carrying its id, exactly like a debt's history is its payments. Nothing
//     is pre-generated, so nothing can rot while the app is closed.
//
//  2. Money in, money out and "what is left" are always DERIVED from records
//     that already exist. `remaining` is never a stored number, so it cannot
//     drift away from the payments that produced it.

// ---------------------------------------------------------------- Occurrence

// One step of the schedule, always derived from the anchor day of the month so
// a 31st anchor walks 31 Jan -> 28 Feb -> 31 Mar instead of drifting to the
// 28th forever.
export function nextOccurrence(recurring, from = recurring?.anchorAt) {
    if (!Number.isFinite(from)) {
        throw new ValidationError("anchorAt", "out_of_range");
    }
    if (recurring.frequency === "daily") return from + DAY_MS;
    if (recurring.frequency === "weekly") return from + 7 * DAY_MS;
    if (recurring.frequency !== "monthly") {
        throw new ValidationError("frequency", "invalid_type");
    }
    const anchor = new Date(recurring.anchorAt);
    const cur = new Date(from);
    const lastDayOfTarget = new Date(cur.getFullYear(), cur.getMonth() + 2, 0).getDate();
    const day = Math.min(anchor.getDate(), lastDayOfTarget);
    return new Date(cur.getFullYear(), cur.getMonth() + 1, day).getTime();
}

// The first occurrence of the schedule that is neither paid nor skipped.
// `null` means "nothing outstanding" (e.g. after a skip of the only due one).
export function nextDueAt(recurring, payments = [], now = Date.now()) {
    if (!Number.isFinite(recurring?.anchorAt)) return null;
    const skipped = new Set(recurring.skipped || []);
    const paid = payments
        .map(p => p?.occurredAt)
        .filter(x => Number.isInteger(x))
        .sort((a, b) => a - b);
    // Every iteration either consumes a payment or a skip, so the walk is
    // bounded by the number of records that could possibly cover it.
    const limit = paid.length + skipped.size + 1;
    let at = recurring.anchorAt;
    for (let i = 0; i < limit; i++) {
        const until = nextOccurrence(recurring, at);
        if (skipped.has(at)) { at = until; continue; }
        // A payment dated inside this occurrence's window settles it.
        if (paid.some(d => d >= at && d < until)) { at = until; continue; }
        return at;
    }
    return null;
}

export function isDue(dueAt, now = Date.now()) {
    return dueAt != null && dueAt <= now;
}

// Reminder offset in days for a due date: null = none, 0 = on the due date.
export function reminderAt(recurring, dueAt) {
    if (dueAt == null) return null;
    const days = recurring?.reminderDays ?? null;
    return days == null ? null : dueAt - days * DAY_MS;
}

// --------------------------------------------------------------- Record build

export function createTransaction(input, { now, id }) {
    return {
        id,
        type: input.type,
        title: input.title,
        amount: input.amount,
        currency: input.currency,
        category: input.category ?? DEFAULT_FINANCE_CATEGORY,
        occurredAt: input.occurredAt ?? now,
        note: input.note ?? null,
        recurringId: input.recurringId ?? null,
        createdAt: now,
        updatedAt: now
    };
}

export function createRecurring(input, { now, id }) {
    return {
        id,
        type: input.type,
        title: input.title,
        amount: input.amount,
        currency: input.currency,
        category: input.category ?? DEFAULT_FINANCE_CATEGORY,
        frequency: input.frequency,
        // The schedule anchor is the day the cycle counts from, and the first
        // due date. Everything after it is derived.
        anchorAt: input.anchorAt ?? now,
        reminderDays: input.reminderDays ?? null,
        skipped: [],
        note: input.note ?? null,
        active: input.active !== false,
        createdAt: now,
        updatedAt: now
    };
}

export function createDebt(input, { now, id }) {
    return {
        id,
        direction: input.direction,
        title: input.title,
        // `personId` is the live link used to group debts by person; `person`
        // is a snapshot of the name, so a debt still reads correctly if the
        // person is later removed.
        personId: input.personId ?? null,
        person: input.person ?? null,
        amount: input.amount,
        currency: input.currency,
        category: input.category ?? DEFAULT_FINANCE_CATEGORY,
        dueAt: input.dueAt ?? null,
        note: input.note ?? null,
        createdAt: now,
        updatedAt: now
    };
}

export function createDebtPayment(input, { now, id }) {
    return {
        id,
        debtId: input.debtId,
        title: input.title ?? null,
        amount: input.amount,
        occurredAt: input.occurredAt ?? now,
        note: input.note ?? null,
        createdAt: now,
        updatedAt: now
    };
}

// ------------------------------------------------------------------ Totals

// Paid and remaining for one debt, derived from its payments. Never stored.
export function debtTotals(debt, payments = []) {
    let paid = 0;
    for (const p of payments) {
        if (p?.debtId === debt.id) paid += p.amount;
    }
    return { paid, remaining: Math.max(0, debt.amount - paid), settled: paid >= debt.amount };
}

/**
 * Every debt's paid/remaining figures, from ONE pass over the payments.
 *
 * debtTotals() is the definition, but it is scoped to a single debt and takes
 * the whole payment list, so a caller that totals a *collection* by calling it
 * per debt walks the payments once per debt. At the app's own caps — 500 debts
 * and 5000 payments — that is two and a half million comparisons, and the Debt
 * screen and the Finance landing page each did it more than once: about 100ms
 * of main-thread arithmetic every time either page opened, for arithmetic that
 * takes under a millisecond when the payments are grouped first.
 *
 * The grouping rule is deliberately the same comparison debtTotals() makes, so
 * the two can never disagree about what "paid" means.
 */
export function debtTotalsById(debts, payments = []) {
    const paidByDebt = new Map();
    for (const p of payments) {
        const id = p?.debtId;
        if (typeof id !== "string") continue;
        paidByDebt.set(id, (paidByDebt.get(id) ?? 0) + p.amount);
    }
    const out = new Map();
    for (const debt of debts) {
        const paid = paidByDebt.get(debt.id) ?? 0;
        out.set(debt.id, {
            paid,
            remaining: Math.max(0, debt.amount - paid),
            settled: paid >= debt.amount
        });
    }
    return out;
}

// A person is a name and an optional note, and nothing else. Which side of a
// debt they are on lives on the debt, so the same person record backs both
// "I owe" and "owed to me".
export function createPerson(input, { now, id }) {
    return {
        id,
        name: input.name,
        note: input.note ?? null,
        createdAt: now,
        updatedAt: now
    };
}

// A category is its own name. There is no separate label to keep in step, so
// renaming a category is just a new id plus rewriting the records that use it.
export function createCategory(input, { now }) {
    return { id: input.id, createdAt: now, updatedAt: now };
}

// Debts grouped by the person they belong to, with both directions totalled
// per person so one row answers "what do I have with Sam?" without arithmetic.
// A debt whose person was removed keeps its name snapshot and joins the
// ungrouped bucket only when it has no personId at all.
export function debtsByPerson(debts, payments = [], people = []) {
    const byId = new Map(people.map(p => [p.id, p]));
    const groups = new Map();
    // One pass over the payments for the whole screen, not one per debt.
    const totals = debtTotalsById(debts, payments);

    for (const debt of debts) {
        const key = debt.personId ?? null;
        let group = groups.get(key);
        if (!group) {
            const person = key ? byId.get(key) : null;
            group = {
                personId: key,
                // The live name when the person still exists, the debt's own
                // snapshot otherwise — a debt stays readable either way.
                name: person?.name ?? debt.person ?? null,
                note: person?.note ?? null,
                missing: !!(key && !person),
                debts: [],
                owedByMe: 0,
                owedToMe: 0,
                total: 0
            };
            groups.set(key, group);
        }
        const figures = totals.get(debt.id);
        group.debts.push({ ...debt, ...figures });
        group.total += debt.amount;
        if (debt.direction === "owed_by_me") group.owedByMe += figures.remaining;
        else group.owedToMe += figures.remaining;
    }

    return [...groups.values()].sort((a, b) => {
        if (!a.personId && !b.personId) return 0;
        if (!a.personId) return 1;  // the no-person bucket sorts last
        if (!b.personId) return -1;
        return (a.name ?? "").localeCompare(b.name ?? "");
    });
}

// A payment may never exceed what is still owed. Overpayment is refused
// instead of silently producing a negative remaining.
export function assertPaymentFits(debt, payments, amount) {
    const { remaining } = debtTotals(debt, payments);
    if (amount > remaining) {
        throw new ValidationError("amount", "exceeds_remaining");
    }
    return true;
}

export function assertDebtExists(debt, id) {
    if (!debt) throw new NotFoundError("debt", id);
    return debt;
}

export function assertRecurringExists(recurring, id) {
    if (!recurring) throw new NotFoundError("recurring", id);
    return recurring;
}

// ------------------------------------------------------------- Aggregation

export function sumByType(transactions, type) {
    let total = 0;
    for (const t of transactions) {
        if (t.type === type) total += t.amount;
    }
    return total;
}

export function expensesByCategory(transactions) {
    const totals = new Map();
    for (const t of transactions) {
        if (t.type !== "expense") continue;
        const key = t.category ?? DEFAULT_FINANCE_CATEGORY;
        totals.set(key, (totals.get(key) || 0) + t.amount);
    }
    return [...totals.entries()]
        .map(([category, amount]) => ({ category, amount }))
        .sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category));
}

// Sooneast first, then most expensive — the order that answers "what is due?"
// before "what costs the most?".
export function upcomingRecurring(recurring, paymentsById, now = Date.now(), limit = 5) {
    return recurring
        .filter(r => r.active)
        .map(r => ({ recurring: r, dueAt: nextDueAt(r, paymentsById.get(r.id) || [], now) }))
        .filter(x => x.dueAt != null)
        .sort((a, b) => a.dueAt - b.dueAt)
        .slice(0, limit);
}

// Groups transactions by the recurring rule that produced them. This is the
// only place the "payment history of a recurring item" is defined: a rule's
// history IS its linked transactions, never a second copy.
export function paymentsByRecurring(transactions) {
    const map = new Map();
    for (const t of transactions) {
        if (!t?.recurringId) continue;
        const list = map.get(t.recurringId);
        if (list) list.push(t);
        else map.set(t.recurringId, [t]);
    }
    return map;
}

// What is left of a rule's history when the rule itself is deleted: the same
// transactions with the link dropped, so the payments the user actually made
// survive as ordinary records. Every one of them has to come back — a payment
// left pointing at a rule that no longer exists is a dangling link the detail
// page would follow to a "not found" screen.
export function unlinkRecurringPayments(payments, now) {
    return payments
        .filter(t => t?.recurringId)
        .map(t => ({ ...t, recurringId: null, updatedAt: now }));
}

export function debtSummary(debts, payments) {
    let owedByMe = 0;
    let owedToMe = 0;
    const totals = debtTotalsById(debts, payments);
    for (const debt of debts) {
        const { remaining } = totals.get(debt.id);
        if (debt.direction === "owed_by_me") owedByMe += remaining;
        else owedToMe += remaining;
    }
    return { owedByMe, owedToMe };
}
