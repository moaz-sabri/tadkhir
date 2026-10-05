import { startOfDay, startOfMonth, dayKey, DAY_MS } from "./time.js";

// Pure aggregation over records the app already stores. Imports nothing but the
// calendar helpers, so every figure here can be tested directly (same style as
// session-engine.js).
//
// Nothing in this module stores or caches a total: reports are derived on read
// from the sessions, tasks and finance records that exist right now. A figure
// can therefore never disagree with the list it was computed from.

export function todaySummary(sessions, now = Date.now()) {
    const start = startOfDay(now);
    let count = 0;
    let totalMs = 0;
    for (const s of sessions) {
        if (s.status === "completed" && s.startedAt >= start) {
            count += 1;
            totalMs += s.actualMs ?? 0;
        }
    }
    return { count, totalMs };
}

// ------------------------------------------------------------------ Periods

// The four windows the reports page offers. `all` has no start, which is
// different from "since the epoch" in exactly one way that matters here: it is
// the only window that never needs a date computation, so it cannot drift at a
// year boundary.
export const REPORT_PERIODS = ["week", "month", "year", "all"];

// The inclusive start of a reporting window, or null for "all time". Weeks start
// on Monday: a report of "this week" that starts on Sunday reads as two almost
// empty days followed by a full one, which is never what the user meant.
export function reportPeriodStart(period, now = Date.now()) {
    if (period === "all") return null;
    if (period === "month") return startOfMonth(now);
    if (period === "year") return new Date(new Date(now).getFullYear(), 0, 1).getTime();
    if (period !== "week") return null;
    const d = new Date(now);
    const sinceMonday = (d.getDay() + 6) % 7;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - sinceMonday).getTime();
}

// Is a record inside the window? A null start means every record qualifies,
// which is what makes "all" a real answer rather than a special case.
function inPeriod(ts, from) {
    return from == null || (Number.isFinite(ts) && ts >= from);
}

// ------------------------------------------------------------------ Figures

// Time and tasks. A session counts as completed work when the user finished it;
// a cancelled one is deliberately excluded, matching todaySummary. Free
// sessions (no task) still count towards time spent — the user was working.
function timeFigures(sessions, from) {
    let count = 0;
    let totalMs = 0;
    let freeCount = 0;
    for (const s of sessions) {
        if (s.status !== "completed" || !inPeriod(s.startedAt, from)) continue;
        count += 1;
        totalMs += s.actualMs ?? 0;
        if (!s.taskId) freeCount += 1;
    }
    return { count, totalMs, freeCount };
}

// "Completed tasks" counts distinct tasks that were finished in the window, not
// sessions: finishing the same task three times is one task done. A task
// deleted after the fact is still counted, because the session row keeps its
// taskId snapshot.
function completedTaskCount(sessions, from) {
    const ids = new Set();
    for (const s of sessions) {
        if (s.status !== "completed" || !s.taskId || !inPeriod(s.startedAt, from)) continue;
        ids.add(s.taskId);
    }
    return ids.size;
}

// Money. Income and expenses are summed separately and the net is their
// difference — the same arithmetic the finance overview does, over the window
// instead of the current month. The currency is whatever the records in the
// window actually use; with none, the caller keeps its own default.
//
// The record count is named `transactionCount`, not `count`: both this and
// timeFigures produce a count, and they are spread into one object, so a
// shared key would silently overwrite the session count with the transaction
// count and the reports page would show a plausible wrong number.
function moneyFigures(transactions, from) {
    let income = 0;
    let expenses = 0;
    let transactionCount = 0;
    let currency = null;
    for (const t of transactions) {
        if (!inPeriod(t.occurredAt, from)) continue;
        transactionCount += 1;
        if (t.currency && !currency) currency = t.currency;
        if (t.type === "income") income += t.amount;
        else expenses += t.amount;
    }
    return { income, expenses, net: income - expenses, transactionCount, currency };
}

// ------------------------------------------------------------------ Summary

// Everything the reports page shows, in one pure call. Debt balances are
// deliberately all-time: "what do I still owe Sam" is a balance, not a flow,
// and slicing it by the selected period would answer a question nobody asked.
// The flow figures in the same object are period-scoped, and `from` is returned
// so the UI can label the window it is looking at.
export function reportSummary(
    { sessions = [], tasks = [], transactions = [], debts = [], debtPayments = [], routines = [], routineLogs = [] } = {},
    period = "month",
    now = Date.now()
) {
    const from = reportPeriodStart(period, now);
    // Spread explicitly, key by key, rather than spreading two figure objects
    // into one. Two spreads is what let a duplicated `count` key silently
    // replace the session count with the transaction count.
    const time = timeFigures(sessions, from);
    const money = moneyFigures(transactions, from);
    return {
        period: REPORT_PERIODS.includes(period) ? period : "all",
        from,
        count: time.count,
        totalMs: time.totalMs,
        freeCount: time.freeCount,
        completedTasks: completedTaskCount(sessions, from),
        income: money.income,
        expenses: money.expenses,
        net: money.net,
        transactionCount: money.transactionCount,
        currency: money.currency,
        // Balances, not flows — see above.
        debts: debtBalance(debts, debtPayments),
        // What the repeated activities actually produced — see routineActivity.
        routine: routineActivity({ routines, routineLogs, sessions }, from),
        // Cheap "how much is in here" indicators for the same window, so the
        // page can say whether the numbers above are worth reading.
        openTasks: tasks.filter(t => !t.archived).length,
        totalTasks: tasks.length
    };
}

/**
 * What the routines actually produced inside the window.
 *
 * This is the one place in the app that reports on a routine, and it is the
 * opposite of a plan: it counts what happened and nothing else. There is no
 * expected column, no missed day and no adherence figure, because a routine is
 * something the user chooses to repeat and a day they did not repeat is not a
 * debt — it is just a day. Nothing is ever reported for a routine that produced
 * nothing, so the list is a record of what was done rather than a scoreboard of
 * what was due.
 *
 * Two kinds, two sources, and neither is copied:
 *   timed    the completed SESSIONS that carry the routine's id. The session is
 *            the app's own record of the run and is already counted by
 *            `timeFigures` above; this only attributes part of it to a rule, so
 *            the two can never add up to more time than was actually spent.
 *   counter  the DAY rows, filtered by when they were last written. A day row is
 *            written the day it belongs to, so its timestamp is inside that day
 *            and a window that starts on a midnight cannot include a day it does
 *            not — which is the whole reason the reports can slice this by period
 *            without a second calendar.
 *
 * An inactive routine is not left out. Pausing a rule does not unring the bell on
 * what it already did, so a routine that was switched off last week still reports
 * the week it was on.
 */
export function routineActivity({ routines = [], routineLogs = [], sessions = [] } = {}, from = null) {
    const rows = [];
    let totalMs = 0;
    let totalRuns = 0;
    const days = new Set();

    for (const routine of routines) {
        const runs = sessions.filter(s =>
            s.status === "completed"
            && s.routineId === routine.id
            && inPeriod(s.startedAt, from)
        );
        const counted = routineLogs.filter(l =>
            l.routineId === routine.id
            && l.count > 0
            && inPeriod(l.updatedAt, from)
        );
        // A routine with nothing in the window is not a row of zeroes: there is
        // no event to report, and a line saying "0 runs" would be a row about a
        // plan rather than about something the user did.
        if (runs.length === 0 && counted.length === 0) continue;

        const ms = runs.reduce((a, s) => a + (s.actualMs ?? 0), 0);
        for (const l of counted) days.add(l.dayKey);

        totalMs += ms;
        totalRuns += runs.length;
        rows.push({
            id: routine.id,
            title: routine.title,
            kind: routine.kind,
            runs: runs.length,
            totalMs: ms,
            days: counted.length,
            count: counted.reduce((a, l) => a + l.count, 0),
            target: routine.target ?? null
        });
    }

    rows.sort((a, b) => b.totalMs - a.totalMs || b.count - a.count
        || String(a.title).localeCompare(String(b.title)));

    return { routines: rows, runs: totalRuns, totalMs, counterDays: days.size };
}

// Outstanding debt totals, both directions. The same derivation the finance
// overview uses, exposed on its own so the reports page needs no import from
// the finance service.
export function debtBalance(debts, payments = []) {
    const paid = new Map();
    for (const p of payments) {
        if (p?.debtId) paid.set(p.debtId, (paid.get(p.debtId) || 0) + p.amount);
    }
    let owedByMe = 0;
    let owedToMe = 0;
    let open = 0;
    for (const d of debts) {
        const remaining = Math.max(0, d.amount - (paid.get(d.id) || 0));
        if (remaining === 0) continue;
        open += 1;
        if (d.direction === "owed_by_me") owedByMe += remaining;
        else owedToMe += remaining;
    }
    return { owedByMe, owedToMe, net: owedToMe - owedByMe, open };
}

// Average length of a completed session in the window, or 0 when there is
// nothing to average. Shown as one more plain indicator, not a chart.
export function averageSessionMs(summary) {
    return summary.count > 0 ? Math.round(summary.totalMs / summary.count) : 0;
}

// How many of the last N calendar days had at least one completed session.
// A one-glance answer to "have I been using this lately?" that needs no chart.
export function activeDays(sessions, days = 7, now = Date.now()) {
    const from = startOfDay(now) - (days - 1) * DAY_MS;
    const seen = new Set();
    for (const s of sessions) {
        if (s.status !== "completed" || !Number.isFinite(s.startedAt) || s.startedAt < from) continue;
        seen.add(new Date(s.startedAt).toDateString());
    }
    return seen.size;
}

// ---------------------------------------------------------------- The dashboard

/**
 * Consecutive days, counting back from today, that each had a completed
 * session.
 *
 * Two rules, both about not lying:
 *  - today not having a session yet does NOT break the streak. A streak read
 *    at 9am would otherwise be zero every morning, which is the one moment a
 *    user is most likely to look at it and be told they had lost it.
 *  - the walk stops at the first empty day, and stops at the store's own
 *    history. A streak longer than the number of sessions on record is not a
 *    streak.
 *
 * Cancelled sessions do not count, same as every other figure here.
 */
export function dayStreak(sessions, now = Date.now()) {
    const days = new Set();
    for (const s of sessions) {
        if (s.status === "completed" && Number.isFinite(s.startedAt)) days.add(dayKey(s.startedAt));
    }
    if (days.size === 0) return 0;
    let streak = 0;
    // Start at today, and step back one day at a time.
    let cursor = startOfDay(now);
    if (!days.has(dayKey(cursor))) {
        // Today is still open: the streak is whatever it was yesterday.
        cursor -= DAY_MS;
        if (!days.has(dayKey(cursor))) return 0;
    }
    while (days.has(dayKey(cursor))) {
        streak += 1;
        cursor -= DAY_MS;
    }
    return streak;
}

// Time per day for the last N days, oldest first, as a plain list. The
// dashboard draws this as a row of bars; there is no chart library in this app
// and none is needed for fourteen numbers.
//
// Every day in the window is present, including the empty ones. A gap is
// information — it is what makes a streak visible — so it is a zero here rather
// than a missing entry.
export function dailyTotals(sessions, days = 14, now = Date.now()) {
    const total = new Map();
    for (const s of sessions) {
        if (s.status !== "completed" || !Number.isFinite(s.startedAt)) continue;
        total.set(dayKey(s.startedAt), (total.get(dayKey(s.startedAt)) ?? 0) + (s.actualMs ?? 0));
    }
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
        const ts = startOfDay(now) - i * DAY_MS;
        out.push({ day: dayKey(ts), at: ts, totalMs: total.get(dayKey(ts)) ?? 0 });
    }
    return out;
}

// ------------------------------------------------------------------ The glance

// Everything the home screen shows below its heading, in one pure call.
//
// The shape of this return value is the decision, and it is a smaller one than
// the screen used to make. The home screen is a glance at now, not a summary of
// the account, so it answers six questions and no more:
//
//   today     the time recorded today
//   expected  the user's OWN average day, to read the first against
//   money     this month's income, expenses and net
//   due       money due today, or due before it
//   tasks     the open tasks worth putting in front of the user now
//   recent    the last few things that were added
//
// What is deliberately NOT here is as deliberate as what is: a fortnight of
// bars, a day streak, a week average, and what is due next month were all on this
// screen once, and all four belong to Reports or to Finance — the two screens
// whose whole job is to hold a summary. A home screen that answers every question
// is a screen nobody reads, and every figure on it is one more thing to keep in
// agreement with a list somewhere else.
//
// The debts ARE here, which is the one addition to that rule, and it is a rule
// about the FIGURE rather than about the service. A debt is the one number a
// person is actually carrying around in their head: "how much do I owe" is not a
// summary of a record, it is the reason the record exists — and a screen that
// reports the month's spending while saying nothing about what is still owed is
// telling the easier half of the story. One figure, the NET of the two
// directions, so the screen states a POSITION rather than two totals to subtract
// in one's head; the full breakdown is still Finance's and Reports'.
//
// It is one function over already-loaded records rather than a service asking
// six services for six answers: one transaction, one pass, and every figure on
// the screen is derived from the same snapshot, so two numbers side by side can
// never come from two different moments.
//
// The add control (a session, an expense, a note) is not here: that is three
// buttons, not a figure.
export function homeGlance(
    {
        sessions = [],
        tasks = [],
        transactions = [],
        recurring = [],
        later = [],
        routines = [],
        pages = [],
        debts = [],
        debtPayments = []
    } = {},
    now = Date.now()
) {
    const today = todaySummary(sessions, now);
    const money = moneyFigures(transactions, startOfMonth(now));
    const balance = debtBalance(debts, debtPayments);

    return {
        today: { count: today.count, totalMs: today.totalMs },
        // null, not a zero: see expectedDailyMs. A first day has no average to
        // be measured against, and the caller draws no comparison rather than
        // drawing "0m against 0m".
        expected: expectedDailyMs(sessions, { now }),
        money: {
            income: money.income,
            expenses: money.expenses,
            net: money.net,
            currency: money.currency,
            // Balances, not flows: what is still owed rather than what moved this
            // month, which is why they are not part of the month's arithmetic and
            // why `net` above is untouched by them. See the note above on why a
            // debt belongs here at all.
            debts: {
                net: balance.net,
                byMe: balance.owedByMe,
                toMe: balance.owedToMe,
                open: balance.open
            }
        },
        due: dueMoney(recurring, transactions, now),
        tasks: tasksForNow(tasks, now),
        recent: recentAdditions({ tasks, sessions, transactions, later, routines, pages }, now)
    };
}

/** How many days back the "expected day" is averaged over. */
export const EXPECTED_WINDOW = 14;

/**
 * The user's own average day, to read today's total against — or null.
 *
 * Three rules, all about not inventing an expectation the user never stated:
 *
 *  - It is DERIVED, never configured. Tadkhir has no daily-goal setting, and adding
 *    one would mean asking the user to predict their own day before living it.
 *    The only expectation available without asking is the one their own history
 *    already states.
 *  - It is null when there is nothing to state one from. A user on their first
 *    day has no expected day, and "0m against an average of 0m" is a comparison
 *    between two absences dressed up as a measurement.
 *  - Today is EXCLUDED, which is not an oversight. Including it makes the figure
 *    move as the day is worked, so at nine in the morning "expected" is a ninth
 *    of a real day and every morning reads as being ahead of it.
 *
 * The span starts at the first day that had time in it rather than at the
 * window's edge, so a user who started Tadkhir on Monday is not told their
 * expected day is a seventh of the one they actually keep.
 */
export function expectedDailyMs(sessions, { window = EXPECTED_WINDOW, now = Date.now() } = {}) {
    // One extra day in the read, then dropped: the window of history plus today.
    const history = dailyTotals(sessions, window + 1, now).slice(0, -1);
    const first = history.findIndex(d => d.totalMs > 0);
    if (first === -1) return null;
    const span = history.length - first;
    const total = history.slice(first).reduce((a, d) => a + d.totalMs, 0);
    return { totalMs: Math.round(total / span), days: span };
}

/**
 * The money that is due today, or was due before it.
 *
 * The due date comes from the same `nextRecurringDue` the finance screens use, so
 * this list and those screens can never disagree about what is owed and when.
 *
 * `limit` is here because this is a phone screen: five obligations with a button
 * each is a list, and thirty is a page — and the rest of them are in Finance, one
 * tap away, where the same question can be asked about all of them at once.
 */
export function dueMoney(recurring = [], transactions = [], now = Date.now(), limit = 5) {
    const byRule = new Map();
    for (const t of transactions) {
        if (!t.recurringId) continue;
        byRule.set(t.recurringId, (byRule.get(t.recurringId) ?? 0) + 1);
    }
    const start = startOfDay(now);
    const out = [];
    for (const rule of recurring) {
        if (rule.active === false) continue;
        const dueAt = nextRecurringDue(rule, byRule.get(rule.id) ?? 0);
        // Due later than today is not "now" — it is a plan, and the plan lives in
        // Finance. Everything at or before the last moment of today is.
        if (dueAt == null || dueAt > start + DAY_MS - 1) continue;
        out.push({
            id: rule.id,
            title: rule.title,
            amount: rule.amount,
            currency: rule.currency,
            dueAt,
            // Said in words by the caller rather than left to a colour, because
            // "overdue" is a claim about a date and not a decoration. The boundary
            // is the START of today, not the clock: something due at 23:00 tonight
            // is due today, however late in the day the reader is looking.
            late: dueAt < start
        });
    }
    // Soonest first, so the most overdue is the first thing read.
    out.sort((a, b) => a.dueAt - b.dueAt || String(a.title).localeCompare(String(b.title)));
    return out.slice(0, limit);
}

/**
 * The open tasks worth putting in front of the user right now, at most `limit`.
 *
 * The order is the whole point, and it is a decision about what "now" means.
 * Something the user PLANNED for a day that has already gone by comes first,
 * then something planned for today, then something they pinned, and only then
 * whatever they happen to have run most often. That last one is a proxy and it
 * is last for that reason: "most used" is a record of the past, not a statement
 * about this morning, and a screen that leads with it leads with a coincidence.
 *
 * A task planned for a day still to come is NOT here. It is not overdue, it is
 * not today's, and putting it on the home screen is the same mistake as putting
 * next month's bills on it — the screen stops being about now.
 */
export function tasksForNow(tasks = [], now = Date.now(), limit = 5) {
    const start = startOfDay(now);
    const rank = t => {
        if (!Number.isFinite(t.plannedAt)) return 2;
        if (t.plannedAt < start) return 0;
        return t.plannedAt < start + DAY_MS ? 1 : 3;
    };
    return tasks
        .filter(t => !t.archived && rank(t) < 3)
        .slice()
        .sort((a, b) => rank(a) - rank(b)
            || Number(b.pinned ?? false) - Number(a.pinned ?? false)
            || (b.usageCount ?? 0) - (a.usageCount ?? 0)
            || String(a.title).localeCompare(String(b.title)))
        .slice(0, limit);
}

/**
 * The last `limit` things the user added, across every service, newest first.
 *
 * Derived from the records themselves rather than kept as an activity log of its
 * own. A separate store of "what happened" would be a second place the same fact
 * lives, and the one thing a summary of this kind must never do is disagree with
 * the services it is summarising — so this is a read, and it cannot fall behind.
 *
 * Each service is dated by the stamp it already keeps, and two kinds of record
 * are left out on purpose:
 *   - a session that has not ended, because it is not yet something that
 *     happened; the home screen shows the running one on its own, and listing it
 *     here as an addition would say the same thing twice;
 *   - a record whose stamp is not a real moment, which is a record that cannot be
 *     placed in a day at all and would sort to the top of a list of days.
 */
export function recentAdditions(
    { tasks = [], sessions = [], transactions = [], later = [], routines = [], pages = [] } = {},
    now = Date.now(),
    limit = 5
) {
    const rows = [];
    const push = (kind, id, title, at, extra = null) => {
        if (!Number.isFinite(at)) return;
        rows.push({ kind, id, title: title || null, at, ...extra });
    };

    for (const t of tasks) push("task", t.id, t.title, t.createdAt);
    for (const s of sessions) {
        if (s.status === "running" || s.status === "paused") continue;
        push("session", s.id, s.taskTitle, s.startedAt, { actualMs: s.actualMs ?? 0 });
    }
    for (const x of transactions) {
        push("transaction", x.id, x.title, x.createdAt ?? x.occurredAt, {
            type: x.type,
            amount: x.amount,
            currency: x.currency
        });
    }
    for (const i of later) push("later", i.id, i.title, i.createdAt);
    for (const r of routines) push("routine", r.id, r.title, r.createdAt);
    for (const p of pages) push("page", p.id, p.title, p.createdAt);

    return rows.sort((a, b) => b.at - a.at || String(a.id).localeCompare(String(b.id))).slice(0, limit);
}

// -------------------------------------------------------------------- The log

/**
 * What happened, day by day, newest day first.
 *
 * The Log is a tool over the services, not a service of its own, and that is the
 * whole of its design: it holds NO record. Every line is derived, on read, from
 * the sessions, transactions, routine days and finished items that already exist,
 * so a log that disagreed with the lists it summarises is not a state this can be
 * in. The alternative — an activity table written alongside every change — is a
 * second copy of the truth that has to be kept correct forever, and a backup or a
 * sync between two devices would have to reconcile it too.
 *
 * The five kinds are the five that answer "what did I do":
 *   session     a session that ENDED. A running one is not in the log, because the
 *               session screen is showing it and the log would be quoting a
 *               duration that is still moving.
 *   transaction money in or money out, dated when it happened.
 *   routine     a day a counter recorded, or a timed run that ended.
 *   task        a task that was closed — the day it was closed, not the day it was
 *               written, because "when did I finish this" is the question.
 *   later       an item that was followed up, on the day it was.
 *
 * Grouped by calendar day, newest first, because the unit a person remembers an
 * activity in is a day and not a timestamp. A day with nothing in it is not
 * present at all: this is a record of what happened, and a heading for a day that
 * holds nothing is a gap in the history rather than a day in it.
 *
 * `from` is exclusive and `now` bounds the other end, so a caller asks for a
 * window rather than for "everything" and decides for itself how much of it to
 * draw — a phone showing a fortnight is not reading five years.
 */
export function activityLog(
    {
        sessions = [],
        transactions = [],
        routineLogs = [],
        routines = [],
        tasks = [],
        later = []
    } = {},
    { from = null, to = Date.now(), kinds = LOG_KINDS } = {}
) {
    const rows = [];
    const wanted = new Set(kinds);

    const add = (kind, id, title, at, extra = null) => {
        if (!wanted.has(kind) || !Number.isFinite(at) || at > to) return;
        if (from != null && at < from) return;
        rows.push({ kind, id, title: title || null, at, ...extra });
    };

    for (const s of sessions) {
        // Only what ended, and dated by when it ended. A cancelled session is in:
        // it happened, it was stopped, and a log that hid the stops would be
        // quietly flattering.
        if (s.status !== "completed" && s.status !== "cancelled") continue;
        add("session", s.id, s.taskTitle, s.endedAt ?? s.startedAt, {
            status: s.status,
            actualMs: s.status === "completed" ? (s.actualMs ?? 0) : 0
        });
    }
    for (const x of transactions) {
        // Dated by when the money moved, not by when the row was typed: a bill
        // entered on Sunday for the 1st belongs to the 1st.
        add("transaction", x.id, x.title, x.occurredAt, {
            moneyType: x.type,
            amount: x.amount,
            currency: x.currency
        });
    }

    const byId = new Map(routines.map(r => [r.id, r]));
    for (const l of routineLogs) {
        if (!l.count) continue;
        const rule = byId.get(l.routineId);
        if (!rule) continue;
        // `l.dayKey` is already a local Y-M-D, and it is the day the tally belongs
        // to — the domain's own key, not a re-derivation that could disagree with
        // the one the counter wrote.
        const at = new Date(`${l.dayKey}T00:00:00`).getTime();
        // The row's id is the RULE's, not the day's: a line in the log opens the
        // thing that happened, and two days of the same counter are two lines that
        // both open the same routine.
        add("routine", l.routineId, rule.title, at, { count: l.count, target: rule.target ?? null });
    }

    for (const t of tasks) {
        if (!t.archived || !Number.isFinite(t.archivedAt)) continue;
        add("task", t.id, t.title, t.archivedAt);
    }
    for (const i of later) {
        if (!Number.isFinite(i.completedAt)) continue;
        add("later", i.id, i.title, i.completedAt);
    }

    // Newest first, and inside a day by the clock rather than by id, so the top of
    // the log is the last thing that happened.
    rows.sort((a, b) => b.at - a.at || String(a.id).localeCompare(String(b.id)));

    // The grouping is here and not in the page: "which day" is a fact about the
    // record, and a page that worked it out for itself would be a second calendar.
    const days = [];
    for (const row of rows) {
        const key = dayKey(row.at);
        const last = days[days.length - 1];
        if (last && last.day === key) last.rows.push(row);
        else days.push({ day: key, at: row.at, rows: [row] });
    }
    return days;
}

/** The five things a log line can be, in the order the filter offers them. */
export const LOG_KINDS = Object.freeze(["session", "transaction", "routine", "task", "later"]);

// The date a rule is NEXT due — the first occurrence that has not been paid and
// has not been skipped, whether that moment has passed or not.
//
// The `cand > now` test this used to carry is gone, and removing it is the whole
// point: with it, an overdue rule was walked straight past and could never be
// reported as overdue at all. A subscription three weeks behind produced a
// candidate for its NEXT occurrence and the home screen said nothing was due,
// which is the one thing a person opening the app to check on a bill must not be
// told. The date is returned and the CALLER decides whether it is now, today, or
// still ahead — those are three different questions and this is the one that
// answers none of them on its own.
//
// Derived here rather than imported so the glance stays a pure module over
// records: a rule with no anchor has no schedule, and that is a real answer.
function nextRecurringDue(rule, paidCount) {
    const anchor = Number.isFinite(rule.anchorAt) ? rule.anchorAt : null;
    if (anchor == null) return null;
    const step = rule.frequency === "daily"
        ? DAY_MS
        : rule.frequency === "weekly"
            ? 7 * DAY_MS
            : null;
    // 24 steps, not 24 occurrences from the anchor: a daily rule that is years
    // behind still lands inside the window, and one that is not behind finds its
    // next occurrence on the first try.
    if (step === null) {
        // Monthly: the same day-of-month, walking forward a month at a time.
        //
        // The time of day is carried across deliberately. `new Date(y, m, d)`
        // defaults it to midnight, and the skipped list holds the moment the
        // user actually skipped (midday, say) — so dropping it here produced a
        // candidate that never matched any skip, and a skipped occurrence came
        // straight back as "due".
        const skipped = new Set(rule.skipped || []);
        const d = new Date(anchor);
        for (let i = 0; i < 24; i++) {
            const cand = new Date(
                d.getFullYear(), d.getMonth() + paidCount + i, d.getDate(),
                d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()
            ).getTime();
            if (!skipped.has(cand)) return cand;
        }
        return null;
    }
    const skipped = new Set(rule.skipped || []);
    for (let i = paidCount; i < paidCount + 24; i++) {
        const cand = anchor + i * step;
        if (!skipped.has(cand)) return cand;
    }
    return null;
}
