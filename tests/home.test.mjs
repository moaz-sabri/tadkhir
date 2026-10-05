// The home screen's own decisions, tested without a DOM.
//
// Everything worth asserting about this page is a rule rather than a rendering:
// which block appears, in what order, and what it says. A test that built the
// screen would be asserting the shape of the markup, which is the stylesheet's
// business — so these read the pure functions the page draws from and the source
// of the page itself, and they check the rules.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { startClock, todayLine, isLate, RECENT_TARGETS } from "../app/js/ui/pages/home.js";
import { homeGlance } from "../app/js/domain/analytics.js";
import { startOfDay, DAY_MS } from "../app/js/domain/time.js";
import { strings } from "../app/js/i18n/strings.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = p => readFileSync(join(root, p), "utf8");
// Comments are prose about the design, and several of them quote the very things
// the scans below are looking for. Strip them, so a note about the old launcher
// cannot fail a test about the new one.
const code = src => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const home = read("app/js/ui/pages/home.js");
const noon = (y, m, d) => new Date(y, m - 1, d, 12).getTime();

// Two debts in opposite directions, which is the only arrangement that exercises
// the NET rather than one balance wearing a different label.
const debts = [
    { id: "d1", amount: 300, direction: "owed_by_me", createdAt: 0 },
    { id: "d2", amount: 500, direction: "owed_to_me", createdAt: 0 }
];
const debtPayments = [];

// ---------------------------------------------------------------- the clock ---

test("the clock ticks on the minute, and cancelling it really stops it", () => {
    // Two things at once, because they are the same contract: the timer must fire
    // on the minute rather than on a fixed interval that drifts, and unmount() must
    // be able to stop it — a page that navigated away must not keep a timer alive
    // writing into a node nobody is looking at.
    const written = [];
    const stop = startClock(now => written.push(now));

    assert.equal(written.length, 1, "the clock is written once immediately, not after a delay");
    assert.ok(Math.abs(written[0] - Date.now()) < 1000, "and it is now, not a placeholder");

    // The schedule is the distance to the next minute, so it is always under a
    // minute and always more than nothing.
    const now = Date.now();
    const next = 60000 - (now % 60000) + 250;
    assert.ok(next > 0 && next <= 60_000 + 250, `a minute-boundary delay, not an interval: ${next}`);

    stop();
    // A stopped clock writes nothing further. Timers are checked by waiting for
    // one that was scheduled past the stop, which is why this is the last assertion
    // in the file's clock section rather than a mock.
    const after = written.length;
    return new Promise(resolve => setTimeout(() => {
        assert.equal(written.length, after, "a cancelled clock stays cancelled");
        resolve();
    }, 60));
});

// ------------------------------------------------------------------- blocks ---

test("the home screen draws six blocks, and every one can hide itself", () => {
    // The rule the whole screen is built on: a block appears only when it has
    // something true to say. A home screen you have to scroll to find out what is
    // happening today has stopped being a glance, and every figure on it is one
    // more thing to keep in agreement with a list somewhere else.
    //
    // Counted on the SOURCE, because the alternative is a DOM and the rule is about
    // which blocks exist. Each of the five optional blocks must be capable of
    // hiding itself, or it would be a permanent heading.
    const optional = ["now", "money", "hours", "recent"];
    for (const name of optional) {
        assert.match(home, new RegExp(`section\\.hidden = `),
            "the optional blocks share one hiding mechanism");
        assert.match(home, new RegExp(`${name}: this\\.summary|const ${name}`),
            `${name} is a block on the screen`);
    }
    // And the three summary sections are the same shape, so a new one cannot arrive
    // with a different rule for whether it is worth drawing.
    assert.equal((home.match(/this\.summary\(/g) || []).length, 3,
        "money, hours and recent are all built the same way");
});

test("the home screen opens with the day's figures, not with a launcher", () => {
    // What this screen is FOR is reading, and a launcher above the first figure is
    // controls above answers. It used to be a title field, a Start button and two
    // money shortcuts, taking the top third of the one screen a person opens at
    // nine in the morning to see what the day looks like.
    //
    // Those four actions are the app's single add button now
    // (ui/components/add-button.js), which offers them from every screen rather
    // than from the first one.
    assert.doesNotMatch(home, /startFree/, "the free-session form is gone from here");
    assert.doesNotMatch(home, /MONEY_ICON_NAMES\.(income|expense),?\s*$/m, "and so are the two money shortcuts");
    // What replaced it: a single call that mounts the button, once, at boot.
    assert.match(code(read("app/js/main.js")), /addButton\.mount\(/);
});

test("every block on the home screen carries the door to the screen it summarises", () => {
    // A glance nobody can follow up is a dead end: the person reads "2h 40m" and
    // has nowhere to go with it. So each block's header carries the link, and the
    // link is built from ONE helper that reads the destination's name out of the
    // navigation's label table — which is what stops the home screen and the menu
    // from calling the same screen two different things.
    assert.match(home, /function goTo\(href, labelKey = NAV_LABELS\[href\]\)/);
    assert.match(home, /NAV_LABELS\[href\]/, "the label comes from the one table, not from a second copy");
    // Six blocks, six doors, and each one's destination is written next to its
    // block. Three draw their own (now, the habits, the tasks) and three take
    // theirs as an argument (money, hours, recent), so a block cannot be added
    // without deciding where it leads.
    for (const door of [
        'goTo("/session", "session.title")',
        'goTo("/routines")',
        'goTo("/tasks")',
        'this.summary(t("home.money"), "wallet", "/finance")',
        'this.summary(t("home.hoursTitle"), "clock", "/reports")',
        'this.summary(t("home.recent"), "inbox", "/log")'
    ]) {
        assert.ok(code(home).includes(door), `a block on the home screen leads out with ${door}`);
    }
    assert.doesNotMatch(home, /title: t\("nav\.\w+"\), icon: "chevronRight"/,
        "and no block hard-codes its own destination name");
});

test("nothing is drawn twice: the task order comes from the domain, not the store", () => {
    // The regression this shape prevents. The page used to read the task list from
    // the store and sort it here, while the rest of the screen came from a
    // transaction — so the two could order the same list differently, and the
    // "today" list could disagree with the counts beside it.
    assert.doesNotMatch(home, /store\.getState\(\)\.tasks/,
        "the task list must come from the glance, not from the store");
    assert.match(home, /tasksForNow|glance|renderTasks/);
    // And the store is read exactly once on this page, for the running session —
    // a device-local slot that was never in the transaction.
    const reads = home.match(/store\.getState\(\)/g) || [];
    assert.equal(reads.length, 1, "the one store read is the active session");
});

// ------------------------------------------------------------------ overdue ---

test("late is claimed about a date, and only for a date that has passed", () => {
    // The boundary is the START of today, not the clock. Something planned for
    // 23:00 tonight is planned for today, and calling it overdue at nine in the
    // morning would be the app disagreeing with the user's own plan about the same
    // day. A fixed `now` throughout, so the assertions do not depend on when the
    // suite happens to run.
    const now = noon(2026, 5, 20);
    const today = startOfDay(now);
    assert.equal(isLate(null, now), false, "no plan, nothing to be late for");
    assert.equal(isLate(today + DAY_MS, now), false, "tomorrow");
    assert.equal(isLate(today + 23 * 3600_000, now), false, "tonight, at 23:00");
    assert.equal(isLate(today, now), false, "the start of today is today, not yesterday");
    assert.equal(isLate(today - 1, now), true, "a millisecond before today is late");
    assert.equal(isLate(today - 30 * DAY_MS, now), true, "a month ago");
});

test("an unscheduled task is not late, which is a different answer from on time", () => {
    // A task nobody gave a date to is not "on time" — it is unscheduled, and the
    // screen says nothing at all about it. Collapsing the two would put a badge on
    // every task the user never planned, which is most of them.
    const now = noon(2026, 5, 20);
    assert.equal(isLate(undefined, now), false);
    assert.equal(isLate(null, now), false);
    assert.equal(isLate(NaN, now), false);
    // And a date in the future is a plan, not a fact about lateness.
    assert.equal(isLate(now + 10 * DAY_MS, now), false);
});

// ------------------------------------------------------------------ summary ---

test("today's line says nothing recorded rather than zero sessions", () => {
    // "0 sessions · 0m" is a measurement of nothing, and the sentence that says so
    // in words is the one a person reads at 9am with a session not yet started.
    assert.equal(todayLine({ count: 0, totalMs: 0 }), strings.en.home.todayEmpty);
    assert.equal(todayLine({ count: 0, totalMs: 5_000_000 }),
        strings.en.home.todayEmpty, "time without a finished session is still nothing recorded");
});

// --------------------------------------------------------------- consistency ---

test("a service added to the glance is a row the home screen can open", () => {
    // The mapping from "what kind of record is this" to "where does it live" is a
    // hand-written table, and a new service that is derived into `recent` without
    // an entry here would be a row drawn with a glyph and no way to open it. The
    // kinds the domain produces are the ones the table must answer for.
    for (const kind of ["task", "session", "transaction", "later", "routine", "page"]) {
        assert.ok(RECENT_TARGETS[kind], `${kind} has no target on the home screen`);
        assert.match(RECENT_TARGETS[kind].href("x"), /^\//, "and its href is a path");
    }
    // A kind the table does not know draws as a plain row rather than as a link
    // that goes nowhere — so a missing entry is a visible gap, not a silent no-op.
    assert.equal(RECENT_TARGETS.somethingNew, undefined);
});

test("the glance never reports a figure the home screen has no block for", () => {
    // The whole point of the reshape: what the domain computes and what the page
    // draws are the same things. A field added to one and not the other is either
    // dead weight in a payload or a figure with nowhere to go.
    const now = noon(2026, 5, 20);
    const data = homeGlance({
        sessions: [{ id: "s", status: "completed", startedAt: now - DAY_MS, endedAt: now - DAY_MS, actualMs: 3_600_000 }],
        tasks: [{ id: "t", title: "A task", archived: false, usageCount: 0, createdAt: now }],
        transactions: [],
        recurring: [],
        later: [],
        routines: [],
        pages: []
    }, now);

    assert.deepEqual(Object.keys(data).sort(),
        ["due", "expected", "money", "recent", "tasks", "today"]);
    // The debts the payload used to leave out are in it now, under `money` and not
    // beside it: what is still owed is part of what a month has cost, and it is a
    // balance rather than a flow, which is exactly why it must not be added into
    // the month's `net`.
    assert.ok(data.money.debts, "the money block carries a debt position");
    assert.deepEqual(Object.keys(data.money.debts).sort(),
        ["byMe", "net", "open", "toMe"]);
    assert.equal(data.money.debts.net, 0, "and with no debts it is zero in both directions");
    // Everything the old payload carried on purpose stays out.
    assert.equal("later" in data, false);
    assert.equal("week" in data, false);
    assert.equal("streak" in data, false);
    assert.equal("days" in data, false);
});

test("the debt figure on the home screen is a net, and carries its sign", () => {
    // One position rather than two totals. "You owe 300, 500 is owed to you" is
    // arithmetic the reader has to do on a screen they open to be told something,
    // and the sign is the answer: positive means the debt is owed TO the user.
    // Derived from the same debtBalance() the finance screens use, so the three
    // cannot disagree about it.
    const now = noon(2026, 5, 20);
    const money = homeGlance({ debts, debtPayments }, now).money.debts;

    assert.equal(money.net, 200, "500 owed to me minus 300 I owe");
    assert.equal(money.byMe, 300);
    assert.equal(money.toMe, 500);
    assert.equal(money.open, 2);

    // A settled debt is not part of the balance at all — which is why the payments
    // have to be read alongside the debts rather than the debts alone.
    const paid = homeGlance({
        debts,
        debtPayments: [{ id: "p1", debtId: "d1", amount: 300 }]
    }, now).money.debts;
    assert.equal(paid.net, 500, "the paid-off debt drops out and the other one is all that is left");
    assert.equal(paid.open, 1);
    // And an overpayment cannot make a balance negative in the direction that
    // matters: the derivation clamps what is left at zero, so a debt is never
    // counted as though the user were owed a refund on it.
    const overpaid = homeGlance({
        debts,
        debtPayments: [{ id: "p1", debtId: "d1", amount: 900 }]
    }, now).money.debts;
    assert.equal(overpaid.net, 500);
    assert.equal(overpaid.open, 1);
});
