import test from "node:test";
import assert from "node:assert/strict";
import {
    toMinorUnits,
    toAmountInputValue,
    formatMoney,
    formatSignedMoney,
    DEFAULT_CURRENCY,
    MINOR_UNITS
} from "../app/js/domain/money.js";
import {
    nextOccurrence,
    nextDueAt,
    isDue,
    reminderAt,
    createTransaction,
    createRecurring,
    createDebt,
    createDebtPayment,
    debtTotals,
    assertPaymentFits,
    assertDebtExists,
    assertRecurringExists,
    sumByType,
    expensesByCategory,
    paymentsByRecurring,
    unlinkRecurringPayments,
    upcomingRecurring,
    debtSummary,
    createCategory,
    createPerson,
    debtsByPerson
} from "../app/js/domain/finance.js";
import { DAY_MS } from "../app/js/domain/time.js";
import { ValidationError, NotFoundError, ImportError } from "../app/js/domain/errors.js";
import {
    validateFinanceTransactionInput,
    validateFinanceRecurringInput,
    validateFinanceDebtInput,
    validateFinanceDebtPaymentInput,
    validateCategoryInput,
    validatePersonInput,
    assertFinanceRecords,
    assertImportShape,
    BUILTIN_FINANCE_CATEGORIES,
    DEFAULT_FINANCE_CATEGORY,
    MAX_FINANCE_CATEGORIES,
    MAX_FINANCE_PEOPLE,
    MAX_FINANCE_AMOUNT,
    MAX_PLANNED_PAST_MS,
    MAX_PLANNED_FUTURE_MS
} from "../app/js/domain/validation.js";
import { migrations } from "../app/js/data/migrations.js";
import { DB_VERSION } from "../app/js/config.js";

// A local calendar day at midnight, the shape a <input type="date"> produces.
const day = (y, m, d) => new Date(y, m - 1, d).getTime();
const NOW = day(2026, 3, 10);

test("toMinorUnits keeps money in integer minor units", () => {
    assert.equal(toMinorUnits("12.99"), 1299);
    assert.equal(toMinorUnits("12,99"), 1299);
    assert.equal(toMinorUnits("0.1"), 10);
    assert.equal(toMinorUnits("7"), 700);
    assert.equal(toMinorUnits(12.99), 1299);
    assert.equal(toMinorUnits(" 3.5 "), 350);
    assert.equal(toMinorUnits("1000000.99"), 100_000_099);
});

test("toMinorUnits rejects anything that is not a positive two-decimal amount", () => {
    for (const bad of ["", " ", "abc", "-1", "-0.01", "-0", "1.234", "1.2.3", "1e3", null, undefined, NaN, Infinity, -5]) {
        assert.equal(toMinorUnits(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
    // Zero parses to 0 minor units; the *validator* is what refuses it as an
    // amount, so a bare "0" is not a parse failure.
    assert.equal(toMinorUnits("0"), 0);
    assert.equal(toMinorUnits("0.00"), 0);
});

test("toAmountInputValue round-trips a minor-unit amount", () => {
    assert.equal(toAmountInputValue(1299), "12.99");
    assert.equal(toAmountInputValue(0), "0.00");
    assert.equal(toAmountInputValue(7), "0.07");
    assert.equal(toAmountInputValue(null), "");
    assert.equal(toAmountInputValue(12.99), "");
    for (const minor of [0, 1, 99, 100, 1299, 999_999_999]) {
        assert.equal(toMinorUnits(toAmountInputValue(minor)), minor);
    }
});

test("formatMoney and formatSignedMoney never show a fraction of a cent", () => {
    assert.match(formatMoney(1299, "EUR"), /12[.,]99/);
    assert.match(formatMoney(-1299, "EUR"), /12[.,]99/);
    assert.equal(formatSignedMoney(0, "EUR"), formatMoney(0, "EUR"));
    assert.ok(formatSignedMoney(500, "EUR").startsWith("+"));
    // A real minus (U+2212), not a hyphen: the figure is typeset at stat size, and
    // a hyphen at that weight is a dash rather than a sign. Asserted as the code
    // point rather than as "-" so the substitution cannot pass.
    assert.ok(formatSignedMoney(-500, "EUR").startsWith("−"),
        `a real minus, got ${JSON.stringify(formatSignedMoney(-500, "EUR"))}`);
    // And the two are never the same string, which is the whole point: a net that
    // prints its absolute value answers the opposite question to the one asked.
    assert.notEqual(formatSignedMoney(-500, "EUR"), formatMoney(-500, "EUR"));
    // A missing or malformed currency falls back to the single app currency
    // instead of printing it: a month with no transactions carries
    // `currency: null`, and "0.00 null" on the dashboard is that hole.
    assert.equal(formatMoney(1299, null), formatMoney(1299, "EUR"));
    assert.equal(formatMoney(1299, undefined), formatMoney(1299, "EUR"));
    assert.equal(formatMoney(1299), formatMoney(1299, "EUR"));
    assert.equal(formatMoney(1299, "NOTACURRENCY"), formatMoney(1299, "EUR"));
    assert.equal(formatMoney(1299, ""), formatMoney(1299, "EUR"));
    assert.equal(formatSignedMoney(-500, null), formatSignedMoney(-500, "EUR"));
    // A non-integer never reaches the formatter as a raw float.
    assert.equal(formatMoney(12.99, "EUR"), formatMoney(0, "EUR"));
    assert.equal(DEFAULT_CURRENCY, "EUR");
    assert.equal(MINOR_UNITS, 100);
});

test("nextOccurrence steps daily and weekly by fixed intervals", () => {
    const anchor = day(2026, 1, 5);
    assert.equal(nextOccurrence({ frequency: "daily", anchorAt: anchor }, anchor), anchor + DAY_MS);
    assert.equal(nextOccurrence({ frequency: "weekly", anchorAt: anchor }, anchor), anchor + 7 * DAY_MS);
    // The step does not depend on the anchor once the schedule is running.
    assert.equal(
        nextOccurrence({ frequency: "weekly", anchorAt: anchor }, anchor + 14 * DAY_MS),
        anchor + 21 * DAY_MS
    );
});

test("nextOccurrence keeps the anchor day of the month instead of drifting", () => {
    // 31st anchor: January -> February clamps -> March returns to the 31st.
    const anchor = day(2026, 1, 31);
    const monthly = { frequency: "monthly", anchorAt: anchor };
    const feb = nextOccurrence(monthly, anchor);
    assert.equal(new Date(feb).getMonth(), 1);
    assert.equal(new Date(feb).getDate(), 28);
    const mar = nextOccurrence(monthly, feb);
    assert.equal(new Date(mar).getMonth(), 2);
    assert.equal(new Date(mar).getDate(), 31);
    const apr = nextOccurrence(monthly, mar);
    assert.equal(new Date(apr).getDate(), 30);
    // A leap February clamps to the 29th.
    const leapAnchor = day(2028, 1, 31);
    const leapMonthly = { frequency: "monthly", anchorAt: leapAnchor };
    assert.equal(new Date(nextOccurrence(leapMonthly, leapAnchor)).getDate(), 29);
});

test("nextOccurrence rejects an unknown frequency and a missing anchor", () => {
    assert.throws(() => nextOccurrence({ frequency: "yearly", anchorAt: NOW }, NOW), ValidationError);
    assert.throws(() => nextOccurrence({ frequency: "monthly", anchorAt: null }, null), ValidationError);
});

test("nextDueAt returns the anchor when nothing has been paid or skipped", () => {
    const anchor = day(2026, 3, 1);
    assert.equal(nextDueAt({ frequency: "monthly", anchorAt: anchor, skipped: [] }, [], NOW), anchor);
    // Even a rule whose anchor is long past still has an outstanding occurrence.
    const old = day(2020, 1, 5);
    assert.equal(nextDueAt({ frequency: "weekly", anchorAt: old, skipped: [] }, [], NOW), old);
    assert.equal(nextDueAt({ frequency: "weekly", anchorAt: old }, [], NOW), old);
    assert.equal(nextDueAt({ frequency: "weekly", anchorAt: null }, [], NOW), null);
});

test("nextDueAt advances past a payment, then past a skip", () => {
    const anchor = day(2026, 3, 1);
    const rule = { frequency: "monthly", anchorAt: anchor, skipped: [] };
    const mar1 = day(2026, 3, 1);
    const apr1 = day(2026, 4, 1);

    // One payment dated on the March occurrence settles March only.
    const paid = { occurredAt: mar1 };
    assert.equal(nextDueAt(rule, [paid], NOW), apr1);
    // A payment in the middle of the window settles it too.
    assert.equal(nextDueAt(rule, [{ occurredAt: day(2026, 3, 15) }], NOW), apr1);
    // Two payments settle March and April.
    assert.equal(nextDueAt(rule, [paid, { occurredAt: apr1 }], NOW), day(2026, 5, 1));

    // A skip moves the schedule on without a transaction.
    const skipped = { ...rule, skipped: [mar1] };
    assert.equal(nextDueAt(skipped, [], NOW), apr1);
    // Skip + payment: March skipped, April paid -> May.
    assert.equal(nextDueAt(skipped, [{ occurredAt: apr1 }], NOW), day(2026, 5, 1));
    // A skipped date that is not on the schedule changes nothing.
    assert.equal(nextDueAt({ ...rule, skipped: [day(2026, 3, 9)] }, [], NOW), mar1);
});

test("isDue and reminderAt treat a due date as a whole day", () => {
    const today = day(2026, 3, 10);
    assert.equal(isDue(null), false);
    assert.equal(isDue(today, NOW + 1000), true);
    assert.equal(isDue(today + DAY_MS, NOW), false);

    const rule = { reminderDays: 3 };
    assert.equal(reminderAt(rule, today), today - 3 * DAY_MS);
    assert.equal(reminderAt(rule, null), null);
    assert.equal(reminderAt({ reminderDays: null }, today), null);
    assert.equal(reminderAt({ reminderDays: 0 }, today), today);
});

test("createTransaction / createRecurring produce complete records with no schedule state", () => {
    const t = createTransaction({
        type: "expense",
        title: "  Groceries  ",
        amount: 2550,
        category: null,
        note: "  weekly  ",
        occurredAt: NOW
    }, { now: NOW, id: "t1" });
    assert.deepEqual(t, {
        id: "t1",
        type: "expense",
        title: "  Groceries  ",
        amount: 2550,
        currency: undefined,
        category: "other",
        occurredAt: NOW,
        note: "  weekly  ",
        recurringId: null,
        createdAt: NOW,
        updatedAt: NOW
    });

    const r = createRecurring({
        type: "expense",
        title: "Rent",
        amount: 90_000,
        currency: "EUR",
        frequency: "monthly",
        anchorAt: day(2026, 4, 1),
        reminderDays: 0,
        active: true
    }, { now: NOW, id: "r1" });
    // The rule carries the schedule inputs and nothing derived: no nextAt,
    // no generated future transactions, an empty skip list.
    assert.equal(r.skipped.length, 0);
    assert.equal("nextAt" in r, false);
    assert.equal(r.anchorAt, day(2026, 4, 1));
    assert.equal(r.active, true);
    assert.equal(r.createdAt, NOW);

    const d = createDebt({
        direction: "owed_by_me",
        title: "Car repair",
        person: "  Sam  ",
        amount: 40_000,
        currency: "EUR",
        dueAt: null
    }, { now: NOW, id: "d1" });
    assert.equal(d.person, "  Sam  ");
    assert.equal(d.dueAt, null);

    const p = createDebtPayment({ debtId: "d1", amount: 1000, occurredAt: NOW }, { now: NOW, id: "p1" });
    assert.equal(p.debtId, "d1");
    assert.equal(p.title, null);
    assert.equal(p.updatedAt, NOW);
});

test("debtTotals derives paid and remaining from the payments alone", () => {
    const debt = { id: "d1", amount: 10_000 };
    const payments = [
        { id: "p1", debtId: "d1", amount: 2500 },
        { id: "p2", debtId: "d1", amount: 1000 },
        { id: "p3", debtId: "other", amount: 99_999 } // a different debt
    ];
    assert.deepEqual(debtTotals(debt, payments), { paid: 3500, remaining: 6500, settled: false });
    assert.deepEqual(debtTotals(debt, []), { paid: 0, remaining: 10_000, settled: false });
    // Fully paid, and the total is a multiple so it settles exactly.
    const exact = [{ id: "p1", debtId: "d1", amount: 10_000 }];
    assert.deepEqual(debtTotals(debt, exact), { paid: 10_000, remaining: 0, settled: true });
    // Over-payment is impossible through the service, but the derived remaining
    // can never go negative even if one arrives from another device.
    const over = [{ id: "p1", debtId: "d1", amount: 12_000 }];
    assert.deepEqual(debtTotals(debt, over), { paid: 12_000, remaining: 0, settled: true });
    assert.equal(debtTotals(debt, over).remaining >= 0, true);
});

test("assertPaymentFits refuses a payment larger than what is left", () => {
    const debt = { id: "d1", amount: 10_000 };
    const paid = [{ id: "p1", debtId: "d1", amount: 6000 }];
    assert.equal(assertPaymentFits(debt, paid, 4000), true);
    assert.equal(assertPaymentFits(debt, paid, 3999), true);
    assert.throws(() => assertPaymentFits(debt, paid, 4001), (e) => {
        return e instanceof ValidationError && e.field === "amount" && e.code === "exceeds_remaining";
    });
    // A settled debt accepts nothing.
    assert.throws(() => assertPaymentFits(debt, [{ id: "p1", debtId: "d1", amount: 10_000 }], 1), ValidationError);
});

test("sumByType and expensesByCategory aggregate in minor units", () => {
    const t = [
        { type: "income", amount: 200_000, category: "work" },
        { type: "expense", amount: 1500, category: "food" },
        { type: "expense", amount: 500, category: "food" },
        { type: "expense", amount: 2500, category: "car" },
        { type: "expense", amount: 100, category: null },
        { type: "income", amount: 50_000, category: "other" }
    ];
    assert.equal(sumByType(t, "income"), 250_000);
    assert.equal(sumByType(t, "expense"), 4600);
    assert.equal(sumByType([], "expense"), 0);
    // Sorted by amount, and a missing category counts as "other".
    assert.deepEqual(expensesByCategory(t), [
        { category: "car", amount: 2500 },
        { category: "food", amount: 2000 },
        { category: "other", amount: 100 }
    ]);
    assert.deepEqual(expensesByCategory([]), []);
});

test("paymentsByRecurring groups only linked transactions", () => {
    const map = paymentsByRecurring([
        { id: "t1", recurringId: "r1", type: "expense", amount: 100 },
        { id: "t2", recurringId: null, type: "expense", amount: 999 },
        { id: "t3", recurringId: "r1", type: "expense", amount: 100 },
        { id: "t4", recurringId: "r2", type: "income", amount: 500 },
        { id: "t5" }
    ]);
    assert.equal(map.size, 2);
    assert.equal(map.get("r1").length, 2);
    assert.equal(map.get("r2").length, 1);
    assert.equal(map.get("missing"), undefined);
    assert.equal(paymentsByRecurring([]).size, 0);
});

test("deleting a rule unlinks EVERY payment it produced, not just the first", () => {
    // Regression: the unlink used to be written inside the write transaction,
    // awaiting the outbox enqueue between rows. That await ended the task, so
    // IndexedDB auto-committed the transaction and every row after the first
    // was written nowhere — the rule was gone while its history still pointed
    // at it, and nothing reported an error. The service now derives the whole
    // set up front, so the rule is "every linked payment, each unlinked".
    const history = [
        { id: "p1", recurringId: "r1", title: "Netflix", amount: 1299, updatedAt: 1, note: null },
        { id: "p2", recurringId: "r1", title: "Netflix", amount: 1299, updatedAt: 2, note: null },
        { id: "p3", recurringId: "r1", title: "Netflix", amount: 1299, updatedAt: 3, note: null }
    ];
    const plain = unlinkRecurringPayments(history, NOW);

    assert.equal(plain.length, history.length, "no payment may be dropped");
    assert.deepEqual(plain.map(p => p.id), ["p1", "p2", "p3"]);
    for (const p of plain) {
        assert.equal(p.recurringId, null, "a deleted rule must not stay referenced");
        assert.equal(p.updatedAt, NOW, "the rewrite has to win the LWW comparison");
        // Nothing else about the payment changes: the user still made it.
        assert.equal(p.amount, 1299);
        assert.equal(p.title, "Netflix");
    }
    // The input is not mutated — the caller still needs the originals.
    assert.equal(history[0].recurringId, "r1");

    // A payment that is not linked to anything is not rewritten, and a rule
    // that was never paid leaves nothing behind.
    assert.deepEqual(unlinkRecurringPayments([{ id: "x", recurringId: null, updatedAt: 1 }], NOW), []);
    assert.deepEqual(unlinkRecurringPayments([], NOW), []);
    // A record with no id cannot be a payment and is skipped rather than
    // written as a broken row.
    assert.deepEqual(unlinkRecurringPayments([null, undefined], NOW), []);
});

test("upcomingRecurring lists active rules soonest first and skips disabled ones", () => {
    const rules = [
        { id: "r1", active: true, frequency: "monthly", anchorAt: day(2026, 5, 1) },
        { id: "r2", active: true, frequency: "monthly", anchorAt: day(2026, 4, 1) },
        { id: "r3", active: false, frequency: "monthly", anchorAt: day(2026, 1, 1) }
    ];
    const history = paymentsByRecurring([{ id: "p1", recurringId: "r2", occurredAt: day(2026, 4, 1) }]);
    const out = upcomingRecurring(rules, history, NOW);
    // r3 is disabled, so it never appears. r2 paid in April and is due in May
    // too; a tie keeps the input order, so the order is r1 then r2.
    assert.deepEqual(out.map(x => [x.recurring.id, x.dueAt]), [
        ["r1", day(2026, 5, 1)],
        ["r2", day(2026, 5, 1)]
    ]);
    // The limit is honoured.
    assert.equal(upcomingRecurring(rules, history, NOW, 1).length, 1);
    assert.deepEqual(upcomingRecurring([], history, NOW), []);
    // A disabled rule is not "upcoming" even though nextDueAt can still find
    // an occurrence for it.
    assert.notEqual(nextDueAt(rules[2], [], NOW), null);
    assert.equal(upcomingRecurring([rules[2]], history, NOW).length, 0);
});

test("debtSummary adds up only what is still owed, per direction", () => {
    const debts = [
        { id: "d1", direction: "owed_by_me", amount: 10_000 },
        { id: "d2", direction: "owed_by_me", amount: 5_000 },
        { id: "d3", direction: "owed_to_me", amount: 2_000 },
        { id: "d4", direction: "owed_to_me", amount: 1_000 }
    ];
    const payments = [
        { id: "p1", debtId: "d1", amount: 4_000 },
        { id: "p2", debtId: "d3", amount: 2_000 } // settles d3 completely
    ];
    // d1: 10000 - 4000 = 6000 and d2: 5000 unpaid -> 11000 owed by me.
    // d3 is fully paid, d4 has no payments -> 1000 still owed to me.
    assert.deepEqual(debtSummary(debts, payments), { owedByMe: 11_000, owedToMe: 1_000 });
    assert.deepEqual(debtSummary([], []), { owedByMe: 0, owedToMe: 0 });
});

test("assertDebtExists and assertRecurringExists report a missing record as not found", () => {
    assert.throws(() => assertDebtExists(null, "d1"), (e) => e instanceof NotFoundError && e.id === "d1");
    assert.throws(() => assertRecurringExists(null, "r1"), (e) => e instanceof NotFoundError && e.id === "r1");
    assert.equal(assertDebtExists({ id: "d1" }, "d1").id, "d1");
    assert.equal(assertRecurringExists({ id: "r1" }, "r1").id, "r1");
});

// -------------------------------------------------------------- validators

const expectFinance = (fn, field, code) => {
    assert.throws(() => fn(), (e) => {
        return e instanceof ValidationError && e.field === field && e.code === code;
    });
};

test("validateFinanceTransactionInput normalizes a valid input", () => {
    const out = validateFinanceTransactionInput({
        type: "expense",
        title: "  Groceries  ",
        amount: 2550,
        category: "food",
        occurredAt: NOW,
        note: "  market  ",
    }, NOW);
    assert.equal(out.title, "Groceries");
    assert.equal(out.note, "market");
    assert.equal(out.currency, DEFAULT_CURRENCY, "no currency in the input means the default");
    assert.equal(out.recurringId, null);
    // A missing or empty category means "no category", not an invented one.
    assert.equal(validateFinanceTransactionInput({ type: "income", title: "x", amount: 1, occurredAt: NOW, category: "" }, NOW).category, null);
    assert.equal(validateFinanceTransactionInput({ type: "income", title: "x", amount: 1, occurredAt: NOW }, NOW).category, null);
    // A real currency code is accepted and kept.
    assert.equal(validateFinanceTransactionInput({ type: "income", title: "x", amount: 1, occurredAt: NOW, currency: "USD" }, NOW).currency, "USD");
});

test("validateFinanceTransactionInput refuses floats, zero and negatives as amounts", () => {
    const base = { type: "expense", title: "x", amount: 100, occurredAt: NOW };
    for (const amount of [0, -1, 12.99, "100", NaN, Infinity, MAX_FINANCE_AMOUNT + 1]) {
        expectFinance(() => validateFinanceTransactionInput({ ...base, amount }, NOW), "amount", "out_of_range");
    }
    // The exact ceiling passes.
    assert.equal(
        validateFinanceTransactionInput({ ...base, amount: MAX_FINANCE_AMOUNT }, NOW).amount,
        MAX_FINANCE_AMOUNT
    );
});

test("validateFinanceTransactionInput checks type, currency and date", () => {
    const base = { type: "expense", title: "x", amount: 100, occurredAt: NOW };
    expectFinance(() => validateFinanceTransactionInput({ ...base, type: "transfer" }, NOW), "type", "invalid_type");
    expectFinance(() => validateFinanceTransactionInput({ ...base, currency: "eu" }, NOW), "currency", "invalid_type");
    expectFinance(() => validateFinanceTransactionInput({ ...base, currency: "EURO" }, NOW), "currency", "invalid_type");
    expectFinance(() => validateFinanceTransactionInput({ ...base, title: "  " }, NOW), "title", "required");
    expectFinance(() => validateFinanceTransactionInput({ ...base, title: "a".repeat(121) }, NOW), "title", "too_long");
    expectFinance(() => validateFinanceTransactionInput({ ...base, note: 42 }, NOW), "note", "invalid_type");
    expectFinance(() => validateFinanceTransactionInput({ ...base, occurredAt: null }, NOW), "occurredAt", "out_of_range");
    // A date outside the 1y/2y window is a typo, not history.
    expectFinance(
        () => validateFinanceTransactionInput({ ...base, occurredAt: NOW + MAX_PLANNED_FUTURE_MS + 1 }, NOW),
        "occurredAt",
        "out_of_range"
    );
    expectFinance(
        () => validateFinanceTransactionInput({ ...base, occurredAt: NOW - MAX_PLANNED_PAST_MS - 1 }, NOW),
        "occurredAt",
        "out_of_range"
    );
    // A category is now any valid name (the service guards existence).
    // Invalid characters in a category name are rejected. The ValidationError
    // uses field "id" because it comes from validateCategoryInput internally.
    expectFinance(() => validateFinanceTransactionInput({ ...base, category: "a\nb" }, NOW), "id", "invalid_type");
    expectFinance(() => validateFinanceTransactionInput({ ...base, category: "a".repeat(121) }, NOW), "id", "too_long");
    assert.equal(validateFinanceTransactionInput({ ...base, category: "custom" }, NOW).category, "custom");
    assert.equal(validateFinanceTransactionInput({ ...base, category: "  trimmed  " }, NOW).category, "trimmed");
    // The category field is validated but existence is NOT checked here -
    // the service does that. An unknown category name passes validation.
    assert.equal(validateFinanceTransactionInput({ ...base, category: "unknown" }, NOW).category, "unknown");
});

test("validateFinanceRecurringInput checks frequency, reminder and anchor", () => {
    const base = { type: "expense", title: "Rent", amount: 90_000, frequency: "monthly", anchorAt: NOW };
    assert.equal(validateFinanceRecurringInput(base, NOW).active, true);
    assert.equal(validateFinanceRecurringInput({ ...base, active: false }, NOW).active, false);
    assert.equal(validateFinanceRecurringInput({ ...base, reminderDays: null }, NOW).reminderDays, null);
    assert.equal(validateFinanceRecurringInput({ ...base, reminderDays: 0 }, NOW).reminderDays, 0);
    assert.equal(validateFinanceRecurringInput({ ...base, reminderDays: 3 }, NOW).reminderDays, 3);

    expectFinance(() => validateFinanceRecurringInput({ ...base, frequency: "yearly" }, NOW), "frequency", "invalid_type");
    // 2 is not on the reminder whitelist.
    expectFinance(() => validateFinanceRecurringInput({ ...base, reminderDays: 2 }, NOW), "reminderDays", "invalid_type");
    // The anchor is reported as "anchorAt", not as a transaction date.
    expectFinance(() => validateFinanceRecurringInput({ ...base, anchorAt: 0 }, NOW), "anchorAt", "out_of_range");
});

test("validateFinanceDebtInput checks direction, person and optional due date", () => {
    const base = { direction: "owed_by_me", title: "Car repair", amount: 40_000 };
    assert.equal(validateFinanceDebtInput(base, NOW).dueAt, null);
    assert.equal(validateFinanceDebtInput(base, NOW).person, null);
    assert.equal(validateFinanceDebtInput({ ...base, person: "  " }, NOW).person, null);
    assert.equal(validateFinanceDebtInput({ ...base, person: " Sam " }, NOW).person, "Sam");
    assert.equal(validateFinanceDebtInput({ ...base, direction: "owed_to_me" }, NOW).direction, "owed_to_me");

    expectFinance(() => validateFinanceDebtInput({ ...base, direction: "both" }, NOW), "direction", "invalid_type");
    expectFinance(() => validateFinanceDebtInput({ ...base, dueAt: -1 }, NOW), "dueAt", "out_of_range");
    expectFinance(() => validateFinanceDebtInput({ ...base, amount: 0 }, NOW), "amount", "out_of_range");
});

test("validateFinanceDebtPaymentInput requires an owning debt and a real amount", () => {
    const base = { debtId: "d1", amount: 1000, occurredAt: NOW };
    assert.equal(validateFinanceDebtPaymentInput(base, NOW).title, null);
    assert.equal(validateFinanceDebtPaymentInput({ ...base, title: "  " }, NOW).title, null);
    assert.equal(validateFinanceDebtPaymentInput({ ...base, title: " part 1 " }, NOW).title, "part 1");
    // A payment without a debt is a broken reference, refused at the door.
    expectFinance(() => validateFinanceDebtPaymentInput({ ...base, debtId: "" }, NOW), "debtId", "invalid_type");
    expectFinance(() => validateFinanceDebtPaymentInput({ ...base, debtId: 7 }, NOW), "debtId", "invalid_type");
    expectFinance(() => validateFinanceDebtPaymentInput({ ...base, amount: 99.5 }, NOW), "amount", "out_of_range");
    expectFinance(() => validateFinanceDebtPaymentInput({ ...base, title: "a".repeat(121) }, NOW), "title", "too_long");
});

// ------------------------------------------------------------ import shape

const validTx = {
    id: "t1",
    type: "expense",
    title: "Groceries",
    amount: 2550,
    currency: "EUR",
    category: "food",
    occurredAt: NOW,
    note: null,
    recurringId: null,
    createdAt: NOW,
    updatedAt: NOW
};
const validRecurring = {
    id: "r1",
    type: "expense",
    title: "Rent",
    amount: 90_000,
    currency: "EUR",
    category: "home",
    frequency: "monthly",
    anchorAt: NOW,
    reminderDays: 0,
    skipped: [NOW],
    note: null,
    active: true,
    createdAt: NOW,
    updatedAt: NOW
};
const validDebt = {
    id: "d1",
    direction: "owed_by_me",
    title: "Car repair",
    person: "Sam",
    amount: 40_000,
    currency: "EUR",
    category: "car",
    dueAt: null,
    note: null,
    createdAt: NOW,
    updatedAt: NOW
};
const validPayment = {
    id: "p1",
    debtId: "d1",
    title: null,
    amount: 10_000,
    occurredAt: NOW,
    note: null,
    createdAt: NOW,
    updatedAt: NOW
};

test("assertFinanceRecords accepts a full set and rejects a broken one", () => {
    assert.equal(assertFinanceRecords({
        transactions: [validTx],
        recurring: [validRecurring],
        debts: [validDebt],
        debtPayments: [validPayment],
        categories: [
            { id: "home" }, { id: "work" }, { id: "car" }, { id: "food" },
            { id: "health" }, { id: "shopping" }, { id: "other" }
        ],
        people: [{ id: "p1", name: "Sam", note: null, createdAt: NOW, updatedAt: NOW }]
    }), true);
    assert.equal(assertFinanceRecords({
        transactions: [],
        recurring: [],
        debts: [],
        debtPayments: [],
        categories: [
            { id: "home" }, { id: "work" }, { id: "car" }, { id: "food" },
            { id: "health" }, { id: "shopping" }, { id: "other" }
        ],
        people: []
    }), true);

    const bad = (detail, records) => assert.throws(
        () => assertFinanceRecords(records),
        (e) => e instanceof ImportError && e.code === "invalid_schema" && e.detail === detail
    );
    // A float amount means money drifted somewhere in the pipeline.
    bad("financeTransactions", { transactions: [{ ...validTx, amount: 12.99 }], recurring: [], debts: [], debtPayments: [], categories: [], people: [] });
    bad("financeTransactions", { transactions: [{ ...validTx, type: "transfer" }], recurring: [], debts: [], debtPayments: [], categories: [], people: [] });
    bad("financeTransactions", { transactions: [{ ...validTx, currency: "eur" }], recurring: [], debts: [], debtPayments: [], categories: [], people: [] });
    bad("financeTransactions", { transactions: [{ ...validTx, occurredAt: 0 }], recurring: [], debts: [], debtPayments: [], categories: [], people: [] });
    bad("financeTransactions", { transactions: [{ ...validTx, id: "" }], recurring: [], debts: [], debtPayments: [], categories: [], people: [] });
    bad("financeRecurring", { transactions: [], recurring: [{ ...validRecurring, frequency: "yearly" }], debts: [], debtPayments: [], categories: [], people: [] });
    bad("financeRecurring", { transactions: [], recurring: [{ ...validRecurring, anchorAt: 0 }], debts: [], debtPayments: [], categories: [], people: [] });
    bad("financeRecurring", { transactions: [], recurring: [{ ...validRecurring, reminderDays: 2 }], debts: [], debtPayments: [], categories: [], people: [] });
    // skipped is a list of timestamps, or absent entirely.
    bad("financeRecurring", { transactions: [], recurring: [{ ...validRecurring, skipped: "nope" }], debts: [], debtPayments: [], categories: [], people: [] });
    bad("financeRecurring", { transactions: [], recurring: [{ ...validRecurring, skipped: [0] }], debts: [], debtPayments: [], categories: [], people: [] });
    assert.equal(assertFinanceRecords({ transactions: [], recurring: [{ ...validRecurring, skipped: undefined }], debts: [], debtPayments: [], categories: [], people: [] }), true);
    bad("financeDebts", { transactions: [], recurring: [], debts: [{ ...validDebt, direction: "both" }], debtPayments: [], categories: [], people: [] });
    bad("financeDebts", { transactions: [], recurring: [], debts: [{ ...validDebt, dueAt: -5 }], debtPayments: [], categories: [], people: [] });
    bad("financeDebtPayments", { transactions: [], recurring: [], debts: [], debtPayments: [{ ...validPayment, debtId: "" }], categories: [], people: [] });
    bad("financeDebtPayments", { transactions: [], recurring: [], debts: [], debtPayments: [{ ...validPayment, amount: 0 }], categories: [], people: [] });
    bad("financeDebtPayments", { transactions: [], recurring: [], debts: [], debtPayments: [{ ...validPayment, title: 42 }], categories: [], people: [] });
    // A payment may carry a label, and a blank one is treated as no label.
    assert.equal(assertFinanceRecords({ transactions: [], recurring: [], debts: [], debtPayments: [{ ...validPayment, title: "part 1" }], categories: [], people: [] }), true);
    assert.equal(assertFinanceRecords({ transactions: [], recurring: [], debts: [], debtPayments: [{ ...validPayment, title: "" }], categories: [], people: [] }), true);
    bad("financeTransactions", { transactions: "not-an-array", recurring: [], debts: [], debtPayments: [], categories: [], people: [] });
    // Categories are a list of names (id is the name).
    bad("financeCategories", { transactions: [], recurring: [], debts: [], debtPayments: [], categories: [{ id: 42 }], people: [] });
    // People have a name and optional note.
    bad("financePeople", { transactions: [], recurring: [], debts: [], debtPayments: [], categories: [], people: [{ id: "p1", name: 42 }] });
});

test("assertImportShape keeps the backup format at version 1 and treats finance as optional", () => {
    const base = { app: "task-timer", version: 1, tasks: [], sessions: [], events: [], settings: {} };
    // A v1 backup written before Finance existed still imports (defaults to built-ins).
    assert.equal(assertImportShape(base), true);
    // A v1 backup that happens to carry finance records is still a v1 backup.
    assert.equal(assertImportShape({
        ...base,
        financeTransactions: [validTx],
        financeRecurring: [validRecurring],
        financeDebts: [validDebt],
        financeDebtPayments: [validPayment],
        financeCategories: [
            { id: "home" }, { id: "work" }, { id: "car" }, { id: "food" },
            { id: "health" }, { id: "shopping" }, { id: "other" }
        ],
        financePeople: [{ id: "p1", name: "Sam", note: null, createdAt: NOW, updatedAt: NOW }]
    }), true);
    // A broken finance record fails the import, reported against its own key.
    assert.throws(
        () => assertImportShape({ ...base, financeTransactions: [{ ...validTx, amount: 1.5 }] }),
        (e) => e instanceof ImportError && e.code === "invalid_schema" && e.detail === "financeTransactions"
    );
    // Present-but-empty is valid, and the format version is never bumped.
    assert.equal(assertImportShape({ ...base, financeTransactions: [], financeDebts: [] }), true);
    assert.throws(() => assertImportShape({ ...base, version: 2 }), (e) => e.code === "newer_version");
});

// ------------------------------------------------- categories and people

test("a category is its own name: no separate label to keep in step", () => {
    // createCategory is a record builder, not a validator: it stores exactly
    // what it is handed. Trimming is validateCategoryInput's job, and the
    // service runs that first — the same split as createTransaction.
    const c = createCategory({ id: "Groceries" }, { now: NOW });
    assert.deepEqual(c, { id: "Groceries", createdAt: NOW, updatedAt: NOW });
    // A category id is free text, so it can be written in any language.
    assert.equal(validateCategoryInput("  Groceries  "), "Groceries");
    assert.equal(validateCategoryInput("Food & Dining"), "Food & Dining");
    assert.equal(validateCategoryInput("بقالة"), "بقالة");
});

test("validateCategoryInput accepts any name but not a broken one", () => {
    const bad = (field, code, value) => assert.throws(
        () => validateCategoryInput(value),
        (e) => e instanceof ValidationError && e.field === field && e.code === code
    );
    bad("id", "invalid_type", 42);
    bad("id", "required", "   ");
    bad("id", "too_long", "a".repeat(121));
    // A control character would break an <option> label.
    bad("id", "invalid_type", "a\nb");
    assert.equal(validateCategoryInput("a".repeat(120)).length, 120);
});

test("the default category is a built-in, which is what keeps the store non-empty", () => {
    assert.ok(BUILTIN_FINANCE_CATEGORIES.includes(DEFAULT_FINANCE_CATEGORY));
    // The default cannot be deleted, so the categories store is never empty and
    // no re-seeding logic is needed anywhere.
    assert.equal(DEFAULT_FINANCE_CATEGORY, "other");
    assert.equal(BUILTIN_FINANCE_CATEGORIES.length, 7);
    // Vocabularies, not logs: far more than anyone types by hand.
    assert.ok(MAX_FINANCE_CATEGORIES >= BUILTIN_FINANCE_CATEGORIES.length);
    assert.ok(MAX_FINANCE_PEOPLE > 0);
});

test("a person is a name and an optional note — never a debtor/creditor type", () => {
    // A record builder, like createCategory: it stores what it is handed, and
    // validatePersonInput is what trims and bounds it beforehand.
    const p = createPerson({ name: "Sam", note: "neighbour" }, { now: NOW, id: "p1" });
    assert.deepEqual(p, { id: "p1", name: "Sam", note: "neighbour", createdAt: NOW, updatedAt: NOW });
    // No balance and no direction on the person: which side of a debt they sit
    // on is decided by each debt that points at them.
    assert.equal("balance" in p, false);
    assert.equal("direction" in p, false);
    // An absent note is stored as null, not as an empty string.
    assert.equal(createPerson({ name: "Sam" }, { now: NOW, id: "p2" }).note, null);

    assert.deepEqual(validatePersonInput({ name: " Sam " }), { name: "Sam", note: null });
    assert.deepEqual(validatePersonInput({ name: "Sam", note: "   " }), { name: "Sam", note: null });
    const bad = (field, code, value) => assert.throws(
        () => validatePersonInput(value),
        (e) => e instanceof ValidationError && e.field === field && e.code === code
    );
    bad("name", "invalid_type", { name: 42 });
    bad("name", "required", { name: "  " });
    bad("name", "too_long", { name: "a".repeat(121) });
    bad("note", "invalid_type", { name: "Sam", note: 42 });
    bad("note", "too_long", { name: "Sam", note: "a".repeat(2001) });
});

test("debtsByPerson groups both directions under one person", () => {
    const people = [{ id: "p1", name: "Sam", note: "neighbour" }];
    const debts = [
        { id: "d1", personId: "p1", person: "Sam", direction: "owed_by_me", amount: 10_000 },
        { id: "d2", personId: "p1", person: "Sam", direction: "owed_to_me", amount: 4_000 }
    ];
    // d1 is half paid, so the group owes 5000 and is owed 4000.
    const payments = [{ debtId: "d1", amount: 5_000 }];
    const [group] = debtsByPerson(debts, payments, people);

    assert.equal(group.personId, "p1");
    assert.equal(group.name, "Sam");
    assert.equal(group.note, "neighbour");
    assert.equal(group.missing, false);
    assert.equal(group.debts.length, 2);
    assert.equal(group.owedByMe, 5_000);
    assert.equal(group.owedToMe, 4_000);
    // Per-debt paid/remaining is derived onto each row, never stored.
    assert.equal(group.debts[0].remaining, 5_000);
    assert.equal(group.debts[0].settled, false);
});

test("debtsByPerson keeps a deleted person's debt readable and sorts the bucket last", () => {
    const debts = [
        // No person at all -> the ungrouped bucket.
        { id: "d0", personId: null, person: null, direction: "owed_by_me", amount: 1_000 },
        // Person removed on another device: the name snapshot keeps it readable.
        { id: "d1", personId: "gone", person: "Alex", direction: "owed_by_me", amount: 2_000 }
    ];
    const groups = debtsByPerson(debts, [], []);

    assert.equal(groups.length, 2);
    const [missing, none] = groups;
    assert.equal(missing.personId, "gone");
    assert.equal(missing.name, "Alex", "falls back to the debt's own name snapshot");
    assert.equal(missing.missing, true, "flagged so the UI can say the person is gone");
    assert.equal(none.personId, null);
    assert.equal(none.name, null);
    assert.equal(none.missing, false);
});

test("debtsByPerson is empty for no debts, and orders groups by name", () => {
    assert.deepEqual(debtsByPerson([], [], []), []);
    const people = [{ id: "b", name: "Zoe" }, { id: "a", name: "Adam" }];
    const debts = [
        { id: "d2", personId: "b", person: "Zoe", direction: "owed_to_me", amount: 1 },
        { id: "d1", personId: "a", person: "Adam", direction: "owed_by_me", amount: 1 }
    ];
    assert.deepEqual(debtsByPerson(debts, [], people).map(g => g.name), ["Adam", "Zoe"]);
});

// -------------------------------------------------------------- migrations

// The minimal slice of IDBDatabase a migration touches. Real IndexedDB is not
// available in node:test and the project has no test dependency, so the
// migration is exercised against a stub that records stores and indexes.
//
// `objectStore` is deliberately NOT on the stub: real IDBDatabase has no such
// method, only the versionchange transaction does. A stub that provides one
// would hide a migration that only works against the stub.
function stubDb() {
    const stores = new Map();
    return {
        stores,
        createObjectStore(name) {
            assert.equal(stores.has(name), false, `${name} must not already exist`);
            const indexes = new Set();
            // `rows` records what a migration writes during the upgrade, so a
            // test can assert that one seeds data and not just a store.
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

const rowsIn = (db, store) => db.stores.get(store).rows;

// The upgrade transaction, which is how a migration reaches a store that an
// earlier migration already created.
function stubTx(db) {
    return {
        objectStore(name) {
            assert.ok(db.stores.has(name), name + " must exist before it can be reopened");
            const store = db.stores.get(name);
            return {
                indexNames: { contains: i => store.indexes.has(i) },
                createIndex: i => store.indexes.add(i)
            };
        }
    };
}

const indexNames = (db, store) => [...db.stores.get(store).indexes];

test("migrations are numbered 1..DB_VERSION with no gaps", () => {
    const versions = Object.keys(migrations).map(Number).sort((a, b) => a - b);
    assert.deepEqual(versions, Array.from({ length: DB_VERSION }, (_, i) => i + 1));
});

test("running every migration in order builds one consistent schema", () => {
    // The full fresh-install path, 1..DB_VERSION against the same stub. This is
    // what a brand-new device does, and it is the path a per-migration test
    // misses: a migration that only works when run in isolation still has to
    // work when its predecessors have already run.
    const db = stubDb();
    for (let v = 1; v <= DB_VERSION; v++) {
        assert.doesNotThrow(() => migrations[v](db, stubTx(db)), `migration ${v} must not throw`);
    }
    // Every store the app reads is present.
    for (const store of ["tasks", "sessions", "events", "meta", "outbox",
        "transactions", "recurring", "debts", "debtPayments", "categories", "people",
        "later"]) {
        assert.ok(db.stores.has(store), `${store} must exist after a full upgrade`);
    }
    // The enc_key index on meta is the one an earlier migration adds to a store
    // a previous migration created. If this is missing, fresh installs and
    // upgraded ones disagree about the schema at the same DB_VERSION.
    assert.ok(indexNames(db, "meta").includes("enc_key"),
        "migration 3 must add its index to the existing meta store");
    // Migration 5 seeds the built-in categories, so a fresh install is usable
    // before the user has created anything.
    const seeded = rowsIn(db, "categories").map(r => r.id);
    assert.ok(seeded.includes(DEFAULT_FINANCE_CATEGORY),
        "the default category must be seeded by the upgrade itself");
    assert.deepEqual(seeded, BUILTIN_FINANCE_CATEGORIES);
});

test("migration 4 creates the four finance stores with their indexes", () => {
    const db = stubDb();
    migrations[4](db);

    // Plural store names, matching the existing tasks/sessions/events/meta.
    assert.deepEqual([...db.stores.keys()].sort(), ["debtPayments", "debts", "recurring", "transactions"]);
    assert.deepEqual(indexNames(db, "transactions").sort(), ["category", "occurredAt", "recurringId"]);
    // Migration 4 is FROZEN: it shipped in DB_VERSION 4. Only `transactions`
    // ever had a category index here — adding one to these two would apply to
    // fresh installs alone and leave every upgraded device without it.
    assert.deepEqual(indexNames(db, "recurring"), ["active"]);
    assert.deepEqual(indexNames(db, "debts"), ["direction"]);
    assert.deepEqual(indexNames(db, "debtPayments"), ["debtId"]);
});

test("the category index exists after any upgrade, not just a fresh install", () => {
    // An already-v4 database: Migration 4 ran long ago and will never run
    // again, so Migration 5 is the only chance to add the index the category
    // manager needs. Reproduced here by running 1..4 first, then 5 alone.
    const db = stubDb();
    for (let v = 1; v <= 4; v++) migrations[v](db, stubTx(db));

    // Precondition: the upgrade really is missing what the manager needs.
    assert.equal(indexNames(db, "recurring").includes("category"), false);
    assert.equal(indexNames(db, "debts").includes("category"), false);

    migrations[5](db, stubTx(db));

    assert.ok(indexNames(db, "recurring").includes("category"),
        "recurring needs a category index for renaming and deleting a category");
    assert.ok(indexNames(db, "debts").includes("category"),
        "debts needs a category index too");
    // The pre-existing indexes are untouched.
    assert.ok(indexNames(db, "recurring").includes("active"));
    assert.ok(indexNames(db, "debts").includes("direction"));
    // A migration itself runs exactly once per version, so it is not expected
    // to be re-runnable — but the index step is individually guarded, which is
    // what keeps a store that already has the index from failing the upgrade.
    assert.equal(new Set(indexNames(db, "recurring")).size, indexNames(db, "recurring").length);
    assert.equal(new Set(indexNames(db, "debts")).size, indexNames(db, "debts").length);
});

test("every store the app reads has the indexes its repos use", () => {
    // Guards the whole class of bug above: a repo calling index(...) for an
    // index no migration ever creates fails only at runtime, on real data.
    const db = stubDb();
    for (let v = 1; v <= DB_VERSION; v++) migrations[v](db, stubTx(db));
    const required = {
        sessions: ["startedAt", "taskId", "status"],
        events: ["sessionId"],
        meta: ["enc_key"],
        outbox: [],
        transactions: ["occurredAt", "category", "recurringId"],
        recurring: ["active", "category"],
        debts: ["direction", "category"],
        debtPayments: ["debtId"],
        categories: [],
        people: [],
        // No index on purpose (the whole list is read and sorted in JS), so the
        // map is empty on purpose too — see data/later.repo.js.
        later: [],
        tasks: []
    };
    for (const [store, indexes] of Object.entries(required)) {
        for (const i of indexes) {
            assert.ok(indexNames(db, store).includes(i), store + " must have a " + i + " index");
        }
    }
});

test("migration 4 is additive: it never touches an existing store", () => {    // Create a pre-existing store first, then check that it and its indexes
    // are still exactly as they were afterwards.
    const db = stubDb();
    db.createObjectStore("events").createIndex("sessionId", "sessionId");
    db.createObjectStore("tasks");
    const before = new Map([...db.stores].map(([k, v]) => [k, [...v.indexes]]));

    migrations[4](db);

    for (const [name, indexes] of before) {
        assert.deepEqual(indexNames(db, name), indexes, `${name} must be unchanged`);
    }
    // The stub's createObjectStore refuses to overwrite, so reaching this point
    // already proves nothing pre-existing was recreated.
    assert.equal(db.stores.size, 6);
});
