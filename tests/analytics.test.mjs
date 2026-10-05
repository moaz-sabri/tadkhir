import test from "node:test";
import assert from "node:assert/strict";
import { todaySummary } from "../app/js/domain/analytics.js";
import {
    reportPeriodStart,
    reportSummary,
    debtBalance,
    averageSessionMs,
    activeDays,
    dayStreak,
    dailyTotals,
    homeGlance,
    expectedDailyMs,
    dueMoney,
    tasksForNow,
    recentAdditions,
    activityLog,
    LOG_KINDS,
    REPORT_PERIODS
} from "../app/js/domain/analytics.js";
import { DAY_MS, startOfDay } from "../app/js/domain/time.js";

const day = (y, m, d) => new Date(y, m - 1, d).getTime();

test("todaySummary aggregates only today's completed sessions", () => {
    const now = new Date(2026, 4, 20, 12, 0).getTime(); // local noon, May 20 2026
    const start = new Date(2026, 4, 20).getTime();

    const sessions = [
        { status: "completed", startedAt: start + 1000, actualMs: 5000 },
        { status: "completed", startedAt: start - 1000, actualMs: 7000 }, // yesterday
        { status: "running", startedAt: start + 2000, actualMs: null },
        { status: "cancelled", startedAt: start + 3000, actualMs: 1 },
        { status: "completed", startedAt: start + 4000, actualMs: null }, // missing actualMs
    ];

    assert.deepEqual(todaySummary(sessions, now), { count: 2, totalMs: 5000 });
});

test("todaySummary returns zeros when empty", () => {
    assert.deepEqual(todaySummary([], 1_800_000_000_000), { count: 0, totalMs: 0 });
});

// ------------------------------------------------------------------ periods

test("report periods are the four windows the page offers", () => {
    assert.deepEqual(REPORT_PERIODS, ["week", "month", "year", "all"]);
});

test("reportPeriodStart: all time has no start, and the others land on a boundary", () => {
    const now = day(2026, 5, 20) + 14 * 60 * 60 * 1000; // May 20, 14:00 local

    // "all" is the only window with no start, which is what makes it different
    // from a range rather than a special case bolted onto the others.
    assert.equal(reportPeriodStart("all", now), null);
    assert.equal(reportPeriodStart("month", now), day(2026, 5, 1));
    assert.equal(reportPeriodStart("year", now), day(2026, 1, 1));
    // An unknown period degrades to all time rather than throwing.
    assert.equal(reportPeriodStart("nope", now), null);
});

test("reportPeriodStart: the week starts on Monday", () => {
    // A report of "this week" starting on Sunday reads as two nearly empty days
    // followed by a full one, which is never what the user meant.
    const sunday = day(2026, 5, 17) + 10 * 60 * 60 * 1000; // Sunday
    assert.equal(new Date(reportPeriodStart("week", sunday)).getDay(), 1);
    assert.equal(reportPeriodStart("week", sunday), day(2026, 5, 11)); // the Monday before

    const monday = day(2026, 5, 18) + 10 * 60 * 60 * 1000; // Monday
    assert.equal(reportPeriodStart("week", monday), day(2026, 5, 18));
    // A Monday crossing a month boundary still resolves to the right Monday.
    const edge = day(2026, 6, 1) + 3600000; // Monday June 1
    assert.equal(reportPeriodStart("week", edge), day(2026, 6, 1));
});

// ------------------------------------------------------------------ balances

test("debtBalance counts only what is still owed, in both directions", () => {
    const debts = [
        { id: "d1", direction: "owed_by_me", amount: 10_000 },
        { id: "d2", direction: "owed_to_me", amount: 2_000 },
        { id: "d3", direction: "owed_to_me", amount: 1_000 }
    ];
    const payments = [
        { debtId: "d1", amount: 4_000 },
        { debtId: "d2", amount: 2_000 } // settles d2 completely
    ];
    // d1 leaves 6000 owed by me; d2 is settled so it is neither owed nor open;
    // d3 has no payments, so 1000 is still owed to me.
    assert.deepEqual(debtBalance(debts, payments), {
        owedByMe: 6_000, owedToMe: 1_000, net: -5_000, open: 2
    });
    assert.deepEqual(debtBalance([], []), { owedByMe: 0, owedToMe: 0, net: 0, open: 0 });
    // A payment for an unknown debt is ignored rather than credited anywhere.
    assert.equal(debtBalance(debts, [{ debtId: "nope", amount: 5_000 }]).owedByMe, 10_000);
});

// ------------------------------------------------------------------ summary

test("reportSummary scopes time and money to the window but not debt balances", () => {
    const now = day(2026, 5, 20) + 14 * 3600000;
    const data = {
        sessions: [
            { id: "s1", status: "completed", taskId: "t1", startedAt: now - 1000, actualMs: 60_000 },
            { id: "s2", status: "completed", taskId: "t2", startedAt: now - 40 * DAY_MS, actualMs: 120_000 },
            { id: "s3", status: "cancelled", taskId: "t3", startedAt: now - 1000, actualMs: 999 }
        ],
        tasks: [{ id: "t1", archived: false }, { id: "t9", archived: true }],
        transactions: [
            { type: "income", amount: 200_000, currency: "EUR", occurredAt: now - 1000 },
            { type: "expense", amount: 2_500, currency: "EUR", occurredAt: now - 2000 },
            { type: "expense", amount: 9_000, currency: "EUR", occurredAt: now - 40 * DAY_MS }
        ],
        // A debt from long ago: still owed, so it belongs in an all-time balance.
        debts: [{ id: "d1", direction: "owed_by_me", amount: 5_000 }],
        debtPayments: []
    };

    const month = reportSummary(data, "month", now);
    // Only the two sessions inside the month.
    assert.equal(month.count, 1);
    assert.equal(month.totalMs, 60_000);
    // A cancelled session is not completed work, matching todaySummary.
    assert.equal(month.completedTasks, 1);
    // Money is window-scoped too: the older expense is excluded.
    assert.equal(month.income, 200_000);
    assert.equal(month.expenses, 2_500);
    assert.equal(month.net, 197_500);
    assert.equal(month.currency, "EUR");
    // But the debt balance is all-time, and `from` is exposed so the UI can
    // label the window it is looking at.
    assert.equal(month.debts.owedByMe, 5_000);
    assert.equal(month.from, day(2026, 5, 1));

    const all = reportSummary(data, "all", now);
    assert.equal(all.count, 2, "all time sees both completed sessions");
    assert.equal(all.expenses, 11_500, "all time sees both expenses");
    assert.equal(all.debts.owedByMe, 5_000, "the debt balance is unchanged by the window");
    assert.equal(all.from, null);
});

test("reportSummary counts distinct completed tasks, not sessions", () => {
    const now = day(2026, 5, 20);
    const s = (id, taskId) => ({ id, status: "completed", taskId, startedAt: now, actualMs: 1000 });
    // The same task finished three times is one task done.
    const out = reportSummary({
        sessions: [s("s1", "t1"), s("s2", "t1"), s("s3", "t1"), s("s4", "t2"), s("s5", null)],
        tasks: []
    }, "month", now);
    assert.equal(out.count, 5, "all five sessions count as time spent");
    assert.equal(out.completedTasks, 2, "but only two distinct tasks");
});

test("reportSummary reports zeros for an empty account instead of throwing", () => {
    const out = reportSummary({}, "month", day(2026, 5, 20));
    assert.equal(out.count, 0);
    assert.equal(out.totalMs, 0);
    assert.equal(out.completedTasks, 0);
    assert.equal(out.income, 0);
    assert.equal(out.expenses, 0);
    assert.equal(out.net, 0);
    assert.equal(out.currency, null, "no records means no currency, so the caller keeps its own");
    assert.equal(out.openTasks, 0);
    assert.equal(out.debts.open, 0);
});

test("reportSummary counts free sessions towards time but not towards tasks", () => {
    const now = day(2026, 5, 20);
    const out = reportSummary({
        sessions: [{ id: "s1", status: "completed", taskId: null, startedAt: now, actualMs: 5000 }],
        tasks: []
    }, "month", now);
    assert.equal(out.count, 1, "the user was working");
    assert.equal(out.totalMs, 5000);
    assert.equal(out.completedTasks, 0, "but there was no task to complete");
});

test("averageSessionMs is a real average, and zero when there is nothing to average", () => {
    assert.equal(averageSessionMs({ count: 2, totalMs: 10_000 }), 5_000);
    assert.equal(averageSessionMs({ count: 0, totalMs: 0 }), 0);
    // Never a division by zero producing NaN.
    assert.equal(Number.isFinite(averageSessionMs({ count: 0, totalMs: 5_000 })), true);
});

test("activeDays counts distinct days, and stays inside its window", () => {
    const now = day(2026, 5, 20) + 20 * 3600000;
    const done = (id, at) => ({ id, status: "completed", taskId: null, startedAt: at, actualMs: 1 });
    // Two sessions today count once; one yesterday; one well outside 7 days.
    assert.equal(activeDays([done("s1", now), done("s2", now - 3600000)], 7, now), 1);
    assert.equal(activeDays([done("s1", now), done("s2", now - DAY_MS)], 7, now), 2);
    assert.equal(activeDays([done("s1", now - 6 * DAY_MS)], 7, now), 1, "six days back is inside");
    assert.equal(activeDays([done("s1", now - 7 * DAY_MS)], 7, now), 0, "seven days back is outside");
    assert.equal(activeDays([], 7, now), 0);
    // Non-completed sessions never make a day "active".
    assert.equal(activeDays([{ id: "s1", status: "cancelled", startedAt: now, actualMs: 1 }], 7, now), 0);
});

/* -------------------------------------------------------------------------- */
/* The dashboard figures                                                       */
/* -------------------------------------------------------------------------- */

// A completed session on a given day, `ms` long, for building histories.
const done = (at, ms = 60_000) => ({
    id: `s${at}`, status: "completed", startedAt: at, actualMs: ms, taskId: null
});
const noon = (y, m, d) => new Date(y, m - 1, d, 12).getTime();

test("a streak counts back from today, and today being empty does not break it", () => {
    const now = noon(2026, 5, 20);
    // Three days ending YESTERDAY, nothing today: read at 9am this must still
    // say 3, because losing the streak every morning is exactly the moment a
    // user is most likely to look at it.
    const sessions = [done(noon(2026, 5, 19)), done(noon(2026, 5, 18)), done(noon(2026, 5, 17))];
    assert.equal(dayStreak(sessions, now), 3);

    // And with today included it is 4, not 3.
    assert.equal(dayStreak([...sessions, done(now)], now), 4);
});

test("a streak stops at the first empty day and never outruns the history", () => {
    const now = noon(2026, 5, 20);
    // A gap at the 18th breaks it: 20 and 19 are consecutive, 17 is not next to 19.
    const gapped = [done(noon(2026, 5, 20)), done(noon(2026, 5, 19)), done(noon(2026, 5, 17))];
    assert.equal(dayStreak(gapped, now), 2);

    // Nothing at all, and nothing today or yesterday.
    assert.equal(dayStreak([], now), 0);
    assert.equal(dayStreak([done(noon(2026, 5, 1))], now), 0);

    // Cancelled sessions never count, same as every other figure here.
    const cancelled = [{ id: "c", status: "cancelled", startedAt: now, actualMs: 1000 }];
    assert.equal(dayStreak(cancelled, now), 0);

    // Two sessions in one day are still one day of a streak.
    const doubled = [done(now), done(now + 3600_000), done(now - DAY_MS)];
    assert.equal(dayStreak(doubled, now), 2);
});

test("dailyTotals returns every day in the window, oldest first, gaps included", () => {
    const now = noon(2026, 5, 20);
    const days = dailyTotals([done(noon(2026, 5, 20), 30_000), done(noon(2026, 5, 18), 10_000)], 14, now);

    assert.equal(days.length, 14, "a gap is a zero, not a missing entry");
    assert.equal(days[13].totalMs, 30_000, "today is last");
    assert.equal(days[11].totalMs, 10_000, "two days back");
    assert.equal(days[12].totalMs, 0, "yesterday had nothing");
    assert.equal(days[0].totalMs, 0, "the oldest day in the window");

    // Oldest first, and each entry is a real day boundary.
    for (let i = 1; i < days.length; i++) {
        assert.ok(days[i].at > days[i - 1].at, "days must ascend");
    }
    assert.equal(days[13].at, startOfDay(now));

    // A cancelled session is not time.
    const withCancelled = dailyTotals([{ id: "x", status: "cancelled", startedAt: now, actualMs: 5000 }], 3, now);
    assert.equal(withCancelled[2].totalMs, 0);
});
// ---------------------------------------------------------------- The glance

test("homeGlance answers the whole home screen from one snapshot", () => {
    const now = noon(2026, 5, 20);
    const day0 = new Date(2026, 4, 1, 12).getTime();
    const data = homeGlance({
        sessions: [
            done(now, 3_600_000),
            done(now - DAY_MS, 1_800_000),
            done(now - 2 * DAY_MS, 900_000)
        ],
        tasks: [
            { id: "a", title: "Kept", archived: false, pinned: true, usageCount: 3, createdAt: day0 },
            { id: "b", title: "Also kept", archived: false, pinned: false, usageCount: 9, createdAt: day0 },
            { id: "c", title: "Old", archived: true, usageCount: 99, createdAt: day0 }
        ],
        transactions: [
            { id: "t1", type: "income", amount: 100_000, currency: "EUR", occurredAt: day0, createdAt: day0, recurringId: null },
            { id: "t2", type: "expense", amount: 25_000, currency: "EUR", occurredAt: day0, createdAt: day0, recurringId: "r1" }
        ],
        // Anchored on the 1st and paid for May, so the next occurrence is the 1st of
        // June — which is AFTER the 20th, and so is not "due now".
        recurring: [{ id: "r1", title: "Salary", amount: 100_000, currency: "EUR", frequency: "monthly", anchorAt: day0, active: true, skipped: [] }],
        later: [
            { id: "l1", title: "Waiting", completedAt: null, createdAt: day0 },
            { id: "l2", title: "Followed up", completedAt: day0, createdAt: day0 }
        ]
    }, now);

    assert.equal(data.today.count, 1);
    assert.equal(data.today.totalMs, 3_600_000);

    // The two sessions before today are 30m and 15m on consecutive days, so the
    // expected day is 22.5 minutes — the average of the days the user actually
    // worked, and NOT the 1h of today's own session.
    assert.equal(data.expected.totalMs, 1_350_000, "45m over two days");
    assert.equal(data.expected.days, 2);

    assert.equal(data.money.income, 100_000);
    assert.equal(data.money.expenses, 25_000);
    assert.equal(data.money.net, 75_000);
    assert.equal(data.money.currency, "EUR");

    // Pinned first, then most used — the same order the task list itself uses.
    assert.deepEqual(data.tasks.map(x => x.id), ["a", "b"]);
    assert.deepEqual(data.due, [], "a rule due next month is not due now");

    // The two open tasks were created before the transaction, which was created
    // before the session was run — so "newest first" is three different stamps and
    // not one.
    // Ten records carry a stamp and the block takes five. The three sessions are
    // the newest thing that happened, so they lead; the rest were all created on
    // the 1st, and the tie between equal stamps is broken by id so the order is
    // stable rather than whatever the store happened to return.
    assert.equal(data.recent.length, 5, "five, because that is the whole point of the block");
    assert.deepEqual(data.recent.map(x => x.kind),
        ["session", "session", "session", "task", "task"]);
    assert.deepEqual(data.recent.slice(3).map(x => x.id), ["a", "b"]);
});

test("homeGlance reports zeros rather than NaN for an empty account", () => {
    const now = noon(2026, 5, 20);
    const data = homeGlance({}, now);
    assert.equal(data.today.count, 0);
    assert.equal(data.today.totalMs, 0);
    assert.equal(data.money.net, 0);
    assert.equal(data.money.currency, null);
    assert.deepEqual(data.due, []);
    assert.deepEqual(data.tasks, []);
    assert.deepEqual(data.recent, []);
    // NOT a zero: there is no history to state an average from, and the page draws
    // no comparison rather than drawing "0m against 0m".
    assert.equal(data.expected, null);
});

// ---- expectedDailyMs --------------------------------------------------------

test("the expected day is the user's own average, and it excludes today", () => {
    const now = noon(2026, 5, 20);
    // 1h, 2h, nothing, then a long day today. Including today would drag the
    // average up as the day is worked, so every morning would read as behind.
    const sessions = [
        done(now - 3 * DAY_MS, 3_600_000),
        done(now - 2 * DAY_MS, 7_200_000),
        done(now, 14_400_000)
    ];
    const expected = expectedDailyMs(sessions, { now });
    // 3h over the THREE days from the first one with time in it to yesterday: the
    // quiet day counts, because a day the user did not work is a day, and averaging
    // only the days they did would report an expected day nobody keeps.
    assert.equal(expected.totalMs, 3_600_000, "today's 4h is not in the average");
    assert.equal(expected.days, 3);
});

test("the average starts at the first day with time in it, not at the window's edge", () => {
    // The user started Tadkhir two days ago. Averaging over the full fortnight would
    // report an expected day of a seventh of the one they actually keep, and today
    // would look like a bad day forever.
    const now = noon(2026, 5, 20);
    const sessions = [done(now - DAY_MS, 3_600_000), done(now, 3_600_000)];
    const expected = expectedDailyMs(sessions, { now });
    assert.equal(expected.totalMs, 3_600_000);
    assert.equal(expected.days, 1);
});

test("no history means no expected day, rather than an expected day of zero", () => {
    const now = noon(2026, 5, 20);
    assert.equal(expectedDailyMs([], { now }), null);
    // Time today and nothing before it is still no history: today's own work cannot
    // be the thing it is measured against.
    assert.equal(expectedDailyMs([done(now, 3_600_000)], { now }), null);
    // A cancelled session is not time, so it is not history either.
    assert.equal(expectedDailyMs([{ id: "c", status: "cancelled", startedAt: now - DAY_MS, actualMs: 9_000_000 }], { now }), null);
});

// ---- dueMoney ---------------------------------------------------------------

test("only money that is due today or was due before it is 'due now'", () => {
    const now = noon(2026, 5, 20);
    const base = { amount: 1000, currency: "EUR", frequency: "monthly", skipped: [] };
    const due = dueMoney([
        // Anchored yesterday, monthly: the next occurrence is a month out, so this
        // one is already a month overdue.
        { ...base, id: "late", title: "Rent", anchorAt: new Date(2026, 3, 20, 12).getTime(), active: true },
        // Daily, anchored at midnight today: due later today, and today is still
        // today at 23:59.
        { ...base, id: "now", title: "Coffee", frequency: "daily", anchorAt: new Date(2026, 4, 20).getTime(), active: true },
        // Daily, anchored yesterday: due earlier today.
        { ...base, id: "earlier", title: "Bus", frequency: "daily", anchorAt: new Date(2026, 4, 19).getTime(), active: true },
        // Due tomorrow. Not now.
        { ...base, id: "tomorrow", title: "Subscription", frequency: "daily", anchorAt: new Date(2026, 4, 21).getTime(), active: true },
        // Due, but switched off.
        { ...base, id: "off", title: "Paused", frequency: "daily", anchorAt: new Date(2026, 4, 19).getTime(), active: false }
    ], [], now);

    // Soonest first, so the most overdue is the first thing read.
    assert.deepEqual(due.map(x => x.id), ["late", "earlier", "now"]);
    assert.deepEqual(due.map(x => x.late), [true, true, false],
        "due before the start of today is overdue; due today is not, however late in the day it is");
});

test("a rule with nothing paid for months is overdue, not 'due next month'", () => {
    // The regression this shape exists to prevent. The walk used to require
    // `cand > now`, which walked an overdue rule straight past and reported its
    // NEXT occurrence — so a subscription three weeks behind showed as nothing due,
    // which is the one thing a person opening the app to check a bill must not be
    // told.
    const now = noon(2026, 5, 20);
    const [bill] = dueMoney([{
        id: "r", title: "Subscription", amount: 999, currency: "EUR", frequency: "monthly",
        anchorAt: new Date(2026, 1, 1, 12).getTime(), active: true, skipped: []
    }], [], now);
    assert.equal(bill.title, "Subscription");
    assert.equal(bill.late, true);
    assert.equal(new Date(bill.dueAt).getMonth(), 1, "the occurrence that was never paid is February's");
});

test("the due list is bounded, because it is on a phone", () => {
    const now = noon(2026, 5, 20);
    const many = Array.from({ length: 12 }, (_, i) => ({
        id: `r${i}`, title: `Bill ${i}`, amount: 1000, currency: "EUR",
        frequency: "daily", anchorAt: new Date(2026, 4, 19).getTime(), active: true, skipped: []
    }));
    assert.equal(dueMoney(many, [], now).length, 5);
    assert.equal(dueMoney(many, [], now, 3).length, 3, "the bound is the caller's to set");
});

test("a skipped occurrence is stepped over rather than reported as due", () => {
    // Anchored in May, May and June paid, and July skipped while the reader is
    // looking at the 20th. The unpaid July is the one that is due, and it was
    // skipped, so the answer is August — which is not now.
    const now = noon(2026, 7, 20);
    const rule = {
        id: "r", title: "Rent", amount: 1000, currency: "EUR", frequency: "monthly",
        anchorAt: new Date(2026, 4, 1, 12).getTime(), active: true, skipped: []
    };
    // Two transactions pointing at the rule are how a paid occurrence is counted.
    const paid = [{ recurringId: "r" }, { recurringId: "r" }];
    const [july] = dueMoney([rule], paid, now);
    assert.equal(new Date(july.dueAt).getMonth(), 6, "July is the unpaid occurrence");
    assert.equal(july.late, true);

    // Skip July, and the same rule has nothing due now: the walk steps over the
    // skipped occurrence to August rather than stopping on it and calling it due.
    const skipped = { ...rule, skipped: [new Date(2026, 6, 1, 12).getTime()] };
    assert.deepEqual(dueMoney([skipped], paid, now), []);
    // And with one more month elapsed it IS due again — the skip moved the due
    // date, it did not cancel the rule.
    const [august] = dueMoney([skipped], paid, noon(2026, 8, 20));
    assert.equal(new Date(august.dueAt).getMonth(), 7, "August");
    assert.equal(august.late, true);
});

// ---- tasksForNow ------------------------------------------------------------

test("tasks are offered late first, then today, then pinned, then most used", () => {
    const now = noon(2026, 5, 20);
    const today = startOfDay(now);
    const rows = tasksForNow([
        { id: "used", title: "Most used", usageCount: 99, pinned: false, plannedAt: null },
        { id: "pinned", title: "Pinned", usageCount: 0, pinned: true, plannedAt: null },
        { id: "today", title: "Planned for today", usageCount: 0, pinned: false, plannedAt: today + 3600_000 },
        { id: "late", title: "Planned for last week", usageCount: 0, pinned: false, plannedAt: today - DAY_MS }
    ], now);

    assert.deepEqual(rows.map(x => x.id), ["late", "today", "pinned", "used"]);
});

test("a task planned for a day still to come is not on the home screen", () => {
    // It is not overdue, it is not today's, and putting it here is the same mistake
    // as putting next month's bills here: the screen stops being about now.
    const now = noon(2026, 5, 20);
    const rows = tasksForNow([
        { id: "future", title: "Next month", usageCount: 50, pinned: true, plannedAt: startOfDay(now) + 20 * DAY_MS },
        { id: "now", title: "Undated", usageCount: 0, pinned: false, plannedAt: null }
    ], now);
    assert.deepEqual(rows.map(x => x.id), ["now"]);
});

test("an archived task is never offered, however it was planned", () => {
    const now = noon(2026, 5, 20);
    const rows = tasksForNow([
        { id: "closed", title: "Finished", archived: true, pinned: true, usageCount: 9, plannedAt: startOfDay(now) - DAY_MS }
    ], now);
    assert.deepEqual(rows, []);
});

test("the task list is bounded, and the bound drops the least urgent", () => {
    const now = noon(2026, 5, 20);
    const many = Array.from({ length: 9 }, (_, i) => ({
        id: `t${i}`, title: `Task ${i}`, usageCount: i, pinned: false, plannedAt: null
    }));
    // Sorted by usage descending, so the tail is the least-used.
    assert.deepEqual(tasksForNow(many, now, 3).map(x => x.id), ["t8", "t7", "t6"]);
});

// ---- recentAdditions --------------------------------------------------------

test("recent additions span the services, newest first", () => {
    // Every kind stamped a different second, so the order below is the ORDER and
    // not a tie-break between equal stamps decided by id.
    const rows = recentAdditions({
        tasks: [{ id: "task", title: "A task", createdAt: 1000 }],
        sessions: [
            { id: "s1", taskTitle: "A session", status: "completed", startedAt: 6000, actualMs: 60_000 },
            // Not something that has happened yet: the home screen shows the running
            // session on its own, and listing it here would say it twice.
            { id: "running", status: "running", startedAt: 9000 },
            { id: "paused", status: "paused", startedAt: 9000 }
        ],
        transactions: [{ id: "x", title: "Groceries", type: "expense", amount: 500, currency: "EUR", createdAt: 5000 }],
        later: [{ id: "l", title: "An idea", createdAt: 2000 }],
        routines: [{ id: "r", title: "Water", createdAt: 3000 }],
        pages: [{ id: "p", title: "Moving flat", createdAt: 4000 }]
    }, day(2026, 5, 20), 10);

    assert.equal(rows.length, 6, "two sessions are still running and are not additions");
    assert.deepEqual(rows.map(x => x.kind),
        ["session", "transaction", "page", "routine", "later", "task"]);
    // And a running session is not an addition, so the newest stamp is the last
    // one that ENDED — not the one that is on the clock right now.
    assert.equal(rows[0].id, "s1");
});

test("a record with no real stamp cannot be placed in a list of moments", () => {
    // It would otherwise sort to the top of "the last five things you added".
    assert.deepEqual(recentAdditions({
        tasks: [{ id: "noStamp", title: "Never stamped", createdAt: null }],
        pages: [{ id: "ok", title: "Fine", createdAt: day(2026, 5, 18) }]
    }, day(2026, 5, 20), 5).map(x => x.id), ["ok"]);
});

test("recent additions are capped at five, because that is the block", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
        id: `t${i}`, title: `T${i}`, createdAt: day(2026, 5, 1) + i * 1000
    }));
    assert.equal(recentAdditions({ tasks: many }, day(2026, 5, 20), 5).length, 5);
    assert.equal(recentAdditions({ tasks: many }, day(2026, 5, 20), 12).length, 12);
});

// ---- activityLog ------------------------------------------------------------

test("the log groups what happened by day, newest day first", () => {
    const now = noon(2026, 5, 20);
    const grouped = activityLog({
        sessions: [
            { id: "s1", taskTitle: "Morning", status: "completed", startedAt: noon(2026, 5, 20) - 3600_000, endedAt: noon(2026, 5, 20) - 1800_000, actualMs: 1_800_000 },
            { id: "s2", taskTitle: "Yesterday", status: "completed", startedAt: noon(2026, 5, 19), endedAt: noon(2026, 5, 19) + 600_000, actualMs: 600_000 }
        ],
        transactions: [{ id: "x", title: "Coffee", type: "expense", amount: 300, currency: "EUR", occurredAt: noon(2026, 5, 20) - 900_000 }]
    }, { to: now });

    assert.equal(grouped.length, 2);
    assert.equal(grouped[0].day, "2026-05-20");
    assert.equal(grouped[1].day, "2026-05-19");
    // Newest first INSIDE the day too, because the top of a log is the last thing
    // that happened rather than the first thing of the morning.
    assert.deepEqual(grouped[0].rows.map(x => x.id), ["x", "s1"]);
    // A day is dated by when the session ENDED: one begun at 23:50 and finished at
    // 00:10 happened across two midnights, and the log has to pick one.
    assert.equal(grouped[1].rows[0].at, noon(2026, 5, 19) + 600_000);
});

test("a day with nothing in it is not a heading", () => {
    const now = noon(2026, 5, 20);
    const grouped = activityLog({
        sessions: [
            { id: "s1", status: "completed", startedAt: noon(2026, 5, 20), endedAt: noon(2026, 5, 20), actualMs: 1000 },
            { id: "s2", status: "completed", startedAt: noon(2026, 5, 18), endedAt: noon(2026, 5, 18), actualMs: 1000 }
        ]
    }, { to: now });
    assert.deepEqual(grouped.map(d => d.day), ["2026-05-20", "2026-05-18"],
        "the 19th had nothing in it, so there is no heading for it");
});

test("the log reports a stopped session rather than hiding it", () => {
    // A history that hid the stops would be quietly flattering, and "how was today"
    // is partly about those.
    const now = noon(2026, 5, 20);
    const grouped = activityLog({
        sessions: [
            { id: "stopped", status: "cancelled", startedAt: now - 3600_000, endedAt: now, actualMs: 3_600_000 },
            { id: "running", status: "running", startedAt: now - 60_000, actualMs: null }
        ]
    }, { to: now });

    assert.deepEqual(grouped[0].rows.map(x => x.id), ["stopped"]);
    assert.equal(grouped[0].rows[0].status, "cancelled");
    // And it contributes no time: a stopped session recorded none.
    assert.equal(grouped[0].rows[0].actualMs, 0);
});

test("the log dates a finished task by when it was closed", () => {
    // NOT by `updatedAt`, which moves every time the task is edited — so a task
    // finished in March and renamed in May would be reported as finished in May.
    const now = noon(2026, 5, 20);
    const grouped = activityLog({
        tasks: [
            { id: "done", title: "Finished in March", archived: true, archivedAt: day(2026, 3, 2), updatedAt: now },
            // An archived task from before the field existed has no stamp, and one
            // with no stamp cannot be placed in a day.
            { id: "old", title: "Archived before the stamp", archived: true, updatedAt: now },
            { id: "open", title: "Still open", archived: false, updatedAt: now }
        ]
    }, { to: now });

    assert.deepEqual(grouped.map(d => d.day), ["2026-03-02"]);
    assert.equal(grouped[0].rows[0].id, "done");
});

test("the log dates a counter by the day it belongs to, not by when the row was written", () => {
    // A day row is written the day it belongs to, so its own `dayKey` IS the day —
    // and reading the row's updatedAt instead would put a corrected tally on the
    // day it was corrected.
    const now = noon(2026, 5, 20);
    const grouped = activityLog({
        routines: [{ id: "r1", title: "Water", target: 8 }],
        routineLogs: [
            { id: "r1@2026-05-19", routineId: "r1", dayKey: "2026-05-19", count: 5, updatedAt: now },
            // A zero is not a tally: the day happened, nothing was recorded on it.
            { id: "r1@2026-05-18", routineId: "r1", dayKey: "2026-05-18", count: 0, updatedAt: now },
            // A day row whose rule is gone is a number with nothing to place it.
            { id: "gone@2026-05-17", routineId: "gone", dayKey: "2026-05-17", count: 3, updatedAt: now }
        ]
    }, { to: now });

    assert.deepEqual(grouped.map(d => d.day), ["2026-05-19"]);
    assert.equal(grouped[0].rows[0].count, 5);
    assert.equal(grouped[0].rows[0].target, 8);
    // The line opens the routine, not the day: two days of one counter are two
    // lines that both open the same thing.
    assert.equal(grouped[0].rows[0].id, "r1");
});

test("the log reads a window, and nothing outside it", () => {
    const now = noon(2026, 5, 20);
    const sessions = [
        { id: "in", status: "completed", startedAt: noon(2026, 5, 19), endedAt: noon(2026, 5, 19), actualMs: 1000 },
        { id: "old", status: "completed", startedAt: noon(2026, 1, 1), endedAt: noon(2026, 1, 1), actualMs: 1000 },
        { id: "future", status: "completed", startedAt: day(2026, 6, 1), endedAt: day(2026, 6, 1), actualMs: 1000 }
    ];
    const grouped = activityLog({ sessions }, { from: noon(2026, 5, 18), to: now });
    assert.deepEqual(grouped.flatMap(d => d.rows.map(x => x.id)), ["in"]);
});

test("the log can be narrowed to some kinds, and defaults to all of them", () => {
    const now = noon(2026, 5, 20);
    const data = {
        sessions: [{ id: "s", status: "completed", startedAt: now - 2000, endedAt: now - 1000, actualMs: 1000 }],
        transactions: [{ id: "x", title: "Coffee", type: "expense", amount: 1, currency: "EUR", occurredAt: now - 500 }]
    };
    assert.deepEqual(
        activityLog(data, { to: now }).flatMap(d => d.rows.map(x => x.kind)),
        ["transaction", "session"],
        "both kinds by default, newest first"
    );
    assert.deepEqual(
        activityLog(data, { to: now, kinds: ["transaction"] }).flatMap(d => d.rows.map(x => x.kind)),
        ["transaction"]
    );
    // And the five kinds the screen offers are the five the derivation produces.
    assert.deepEqual([...LOG_KINDS], ["session", "transaction", "routine", "task", "later"]);
});

test("an account with nothing in it has an empty log rather than a broken one", () => {
    const now = noon(2026, 5, 20);
    assert.deepEqual(activityLog({}, { to: now }), []);
    assert.deepEqual(activityLog(undefined, { to: now }), []);
});
