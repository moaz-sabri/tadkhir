import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { store } from "../../app/store.js";
import { MONEY_ICON_NAMES } from "../icons.js";
import { formatShort, formatTime, formatDateLong, startOfDay } from "../../domain/time.js";
import { formatMoney, formatSignedMoney } from "../../domain/money.js";
import { toast } from "../components/toast.js";
import { sessionService } from "../../services/session-service.js";
import { routineService } from "../../services/routine-service.js";
import { reportService } from "../../services/report-service.js";
import { router } from "../../app/router.js";
import { checkBackupReminder } from "../../services/backup-reminder.js";
import { closeTask } from "../components/close-task.js";
import { timeMeter } from "../components/display.js";
import { routineRow } from "../components/routine-row.js";
import { laterLabel } from "../../domain/later.js";
import { haptics } from "../../app/haptics.js";
import { NAV_LABELS } from "../components/nav.js";
import {
    page,
    pageHead,
    pageSection,
    list,
    listRow,
    rowAction,
    emptyState,
    badge,
    action,
    stat,
    statPairs,
    card,
    cardGrid,
    sectionTitle
} from "../components/ui.js";

// The home screen is a GLANCE, not a dashboard, and it is a report rather than a
// launcher.
//
// It answers six questions and no more, and every block below is one of them, in
// the order they are asked:
//
//   the clock   what time is it, and what day
//   now         what is already running, and what is due
//   money       this month in four figures, and what is still owed
//   time        today's hours against the day I usually keep
//   today       today's habits, and the tasks worth putting in front of me
//   recent      the last few things I added
//
// The order is the order of a morning: what is happening, what it cost, how much
// of the day is gone, what is left to do, and then what has been happening
// lately — which is the only one of the six a person is not asking about right
// now, and it is last for that reason.
//
// It used to answer a dozen more — a fortnight of bars, a day streak, a week
// average and session count, what was due next month, how many Later items were
// waiting — and every one of them was a question for a screen whose whole job is
// to hold a summary. The rule this screen is built on is that a block appears
// only when it has something true to say: an empty "Now" on a calm morning is a
// heading above nothing, and a home screen you have to scroll to find out what is
// happening today has stopped being a glance.
//
// It used to OPEN with a launcher — a title field, a Start button and two money
// shortcuts — above everything else. That is controls above answers, on the one
// screen a person opens to read rather than to compose, and it is now the app's
// single add button in the corner (ui/components/add-button.js), which does the
// same four things from anywhere in the app.
//
// Every block carries the door to the screen it summarises. A glance that cannot
// be followed up is a dead end: the person reads "2h 40m" and has nowhere to go
// with it. So the button is in the section's own header, it says where it goes,
// and it is the destination's own name from the one navigation label table —
// which means the home screen and the menu cannot end up calling the same screen
// two different things.
export const home = {
    title: () => t("nav.home"),

    async mount(root) {
        // ---- The clock ------------------------------------------------------
        // The heading IS the time and the date, not the word "Home". The screen is
        // about now, and a title naming the screen spends its most prominent line
        // on something the reader already knows from the tab they are looking at.
        const clockTime = h("span", { class: "home-clock-time number" });
        const clockDate = h("span", { class: "home-clock-date" });
        const clock = h("span", { class: "home-clock" },
            clockTime,
            // Punctuation, not a word: hidden from anything reading the two values
            // aloud, so the time and the date are announced as two facts rather
            // than with a separator between them.
            h("span", { class: "home-clock-sep", "aria-hidden": "true" }, "·"),
            clockDate
        );

        // ---- Now: running, and due ------------------------------------------
        // The one block whose box is a plain div rather than a `.list`: it holds
        // CARDS, not rows — the running session and the due money side by side from
        // the width two cards fit at — so a list inside it would put row hairlines
        // between two things that are not a list.
        //
        // Born hidden, like the three summaries below: this block is empty until
        // the glance resolves, and a heading that appears over nothing and then
        // disappears is a flash on every single visit to the screen.
        const nowBox = h("div", { class: "home-now" });
        const nowSection = pageSection({
            title: t("home.now"),
            icon: "bolt",
            // The session in progress: a screen, not a section, so it has no row in
            // the menu and its name is passed rather than looked up.
            action: goTo("/session", "session.title"),
            body: nowBox,
            hidden: true
        });

        // ---- The three summaries --------------------------------------------
        // Money, time and recent are the same shape: a titled section with a box in
        // it and a door out of it, born hidden, and only the render pass decides
        // whether it has anything to say. The order they are appended below is the
        // order the glance is filled in, and it is the order of a morning.
        const money = this.summary(t("home.money"), "wallet", "/finance");
        const hours = this.summary(t("home.hoursTitle"), "clock", "/reports");

        // ---- Today: routines and tasks --------------------------------------
        // The repeating things, and ONLY today's: a daily routine, and a weekly
        // one whose weekday is this one. A routine from another day is not on this
        // screen at all — not greyed out, not marked late, not counted. A day the
        // user did not repeat is a day, not a debt, and the home screen is where
        // that rule is easiest to keep.
        //
        // Habits first, then tasks: a habit is something that happens whether or
        // not anybody decides to, and a task is a thing waiting to be chosen. The
        // section disappears when the user has no routines, because an empty
        // section under the day's figures is a thing to read before starting
        // anything. The door to create the first one is /routines itself.
        const routinesBox = h("div", { class: "list" });
        const routinesSection = pageSection({
            title: t("routine.todayList"),
            icon: "repeat",
            action: goTo("/routines"),
            body: routinesBox,
            // Born hidden for the same reason as the blocks below: there is no
            // routine to draw until the read lands, and an empty section under the
            // day's figures is a thing to read before starting anything.
            hidden: true
        });

        // The tasks, in the order domain/analytics.js decided — late first, then
        // today, then pinned, then most used — which is why they come from the
        // shared snapshot below and not from the store.
        const tasksBox = h("div", { class: "list" });
        const tasksSection = pageSection({
            title: t("home.todayTasks"),
            icon: "tasks",
            action: goTo("/tasks"),
            body: tasksBox,
            hidden: true
        });
        const recent = this.summary(t("home.recent"), "inbox", "/log");

        this.routinesBox = routinesBox;
        this.routinesSection = routinesSection;
        this.tasksBox = tasksBox;
        this.tasksSection = tasksSection;

        // Every block the render pass draws into, in one place. The two that need a
        // callback rather than a plain body — the clock is written by a timer, and
        // these are written by an async read — are the reason this is an object
        // rather than a list of local consts: a render pass that has been unmounted
        // finds `parts` null and writes into nothing, rather than into a closure
        // over nodes the router already replaced.
        this.parts = {
            now: { box: nowBox, section: nowSection },
            money,
            hours,
            recent
        };

        // The same page element every screen gets, with no width of its own: this
        // screen used to carry a class that capped it at a narrower measure than the
        // frame's, on the argument that a figure like "1,770.50" reads badly spread
        // across 1180px. What it needed was for a section's action to sit at the far
        // end of its line rather than beside its caption, so the ends of the lines
        // lined up — which is now a rule about every section head rather than a
        // width for this one page. With the cap gone there is nothing left to add
        // here, and a second grid layer around the page would put a gap between the
        // page's own gap and the frame's, which is exactly the kind of invisible
        // spacing that makes a screen feel assembled rather than designed.
        root.append(page(
            pageHead({ title: clock, icon: "home" }),
            nowSection,
            money.section,
            hours.section,
            routinesSection,
            tasksSection,
            recent.section
        ));

        // The wall clock turns once a minute, so the tick is a minute and not a
        // second — this app's rule is little movement, and a clock ticking every
        // second is motion with nothing behind it. unmount() cancels it.
        this.stopClock = startClock((now) => {
            clockTime.textContent = formatTime(now);
            clockDate.textContent = formatDateLong(now);
        });

        this.renderRoutines();
        this.loadGlance();

        // Everything below the launcher is one snapshot, so it is drawn together
        // and refreshed together. Reading the tasks from the store at mount time
        // instead would be a second copy of the same list, free to disagree with
        // the one the rest of the screen was computed from.
        const offTasks = store.subscribe(s => s.tasks, () => this.loadGlance());
        // The running session, and only that: a timed routine is done when its
        // session ENDS, which is the one moment `active` changes, so this is the
        // subscription that makes a routine show itself as finished without the
        // page having to poll. The counter writes its own row and redraws itself,
        // so it needs no subscription at all.
        const offActive = store.subscribe(s => s.active, () => {
            this.renderRoutines();
            this.loadGlance();
        });
        this.unsubs = [offTasks, offActive];

        checkBackupReminder();
    },

    unmount() {
        this.stopClock?.();
        this.stopClock = null;
        this.unsubs?.forEach(unsub => unsub());
        this.unsubs = null;
        this.parts = null;
        this.routinesBox = null;
        this.routinesSection = null;
        this.tasksBox = null;
        this.tasksSection = null;
    },

    // One titled section with a box in it, and the pair kept together so the
    // render pass can fill the box and hide the section without either of them
    // having to find the other in the DOM.
    //
    // BORN HIDDEN. The read that fills these boxes is a transaction over nine
    // stores, so for a moment after the page appears they are empty — and a
    // section that starts visible and is hidden a moment later flashes its heading
    // over nothing, which is precisely the thing this screen is built not to do.
    // The render pass is the only thing that unhides one, and it does so in the same
    // tick it fills the box.
    //
    // `href` is the screen this block summarises, and it is a PARAMETER rather
    // than something each block hard-codes: the reason the door is here at all is
    // the same for all of them, and three blocks that each wrote their own link
    // would be three chances to point at the wrong one.
    summary(title, icon, href) {
        const box = h("div", { class: "list" });
        const section = pageSection({
            title,
            icon,
            action: goTo(href),
            body: box,
            hidden: true
        });
        return { box, section };
    },

    /**
     * Draw today's routines, or nothing at all.
     *
     * Guarded on the node the same way `loadGlance` is: this reads three stores
     * and the user can navigate away while it is in flight, and a page writing
     * into a node the router already replaced is a silent no-op at best.
     */
    async renderRoutines() {
        const box = this.routinesBox;
        const section = this.routinesSection;
        if (!box || !section) return;
        let today;
        try {
            today = await routineService.today();
        } catch {
            return;   // a read that fails says nothing about the day; leave the screen as it was
        }
        if (this.routinesBox !== box || !document.body.contains(box)) return;
        section.hidden = today.length === 0;
        if (today.length === 0) return;
        box.replaceChildren(list(...today.map(view => routineRow(view, {
            onStart: id => this.startRoutine(id),
            onBump: (id, delta) => this.bumpRoutine(id, delta)
        }))));
    },

    async startRoutine(id) {
        try {
            await routineService.start(id);
            router.navigate("/session");
        } catch (e) {
            toast.show(`error.${e?.code || "unexpected"}`);
        }
    },

    async bumpRoutine(id, delta) {
        try {
            await routineService.bump(id, delta);
            haptics.do("ack");
            await this.renderRoutines();
            this.loadGlance();
        } catch (e) {
            toast.show(`error.${e?.code || "unexpected"}`);
        }
    },

    /**
     * Read the whole screen in one transaction, then draw it.
     *
     * The token is the guard the other reads on this page use, in the form that
     * catches the case they cannot: two loads in flight at once, the slower one
     * finishing second. Without it, a glance that was asked for before a task was
     * closed lands after the one that was, and the screen goes backwards.
     */
    async loadGlance() {
        const token = (this.glanceToken = (this.glanceToken ?? 0) + 1);
        let data = null;
        try {
            data = await reportService.glance();
        } catch (e) {
            // A read that failed says nothing about the day. The blocks are left
            // as they were rather than replaced with an error, because a wrong
            // figure about someone's own records is worse than an old one.
            console.warn("home glance failed:", e);
        }
        if (this.glanceToken !== token || !this.parts) return;
        this.renderNow(data);
        this.renderMoney(data);
        this.renderHours(data);
        this.renderTasks(data);
        this.renderRecent(data);
    },

    // ---- Now: what is running, and what is due ------------------------------

    renderNow(data) {
        const part = this.parts?.now;
        if (!part) return;
        const { box, section } = part;

        // The running session is read from the store rather than from the
        // snapshot: it is a device-local active slot, it was never part of the
        // transaction, and the subscription on `active` is what brings the page
        // back for it.
        const running = store.getState().active;
        const due = data?.due ?? [];

        // Nothing running and nothing due: the block says nothing, so it is not
        // drawn. A heading above an empty list is a thing to read before starting
        // anything, and this screen would then have four of them.
        section.hidden = !running && due.length === 0;
        if (section.hidden) return box.replaceChildren();

        const parts = [];
        if (running) {
            parts.push(card(
                sectionTitle(t("home.currentSession"), { icon: "clock" }),
                runningSummary(running)
            ));
        }
        if (due.length > 0) {
            parts.push(card(
                sectionTitle(t("home.dueNow"), { icon: "calendar" }),
                list(...due.map(item => listRow({
                    href: `/finance/recurring/${item.id}`,
                    icon: MONEY_ICON_NAMES[item.type] ?? "wallet",
                    title: item.title,
                    meta: [
                        badge(formatMoney(item.amount, item.currency)),
                        // Said in words rather than left to a colour, because
                        // "overdue" is a claim about a date and not a decoration.
                        badge(
                            item.late ? t("home.dueLate") : t("home.dueToday"),
                            { icon: "calendar", tone: item.late ? "danger" : "" }
                        )
                    ]
                })))
            ));
        }
        // One card goes in alone; two share the row. `fill` rather than
        // `replaceChildren(...parts)` for the reason it documents — an array handed
        // to the native method is stringified, not spread.
        fill(box, parts.length === 1 ? parts[0] : cardGrid(...parts));
    },

    // ---- Money, this month, and what is still owed ---------------------------

    renderMoney(data) {
        const part = this.parts?.money;
        if (!part) return;
        const { box, section } = part;
        if (!data) return box.replaceChildren(h("p", { class: "muted small" }, t("common.loading")));

        const { income, expenses, net, currency, debts } = data.money;
        const owed = debts?.open ?? 0;
        // A month with nothing in it is not a month whose net is zero, it is a
        // month with no money in it — and four zeroes under a heading is a card
        // the reader has to get past to reach the next thing.
        if (!income && !expenses && !owed) {
            section.hidden = true;
            return box.replaceChildren();
        }
        section.hidden = false;

        fill(box, statPairs(
            // Spending first, because it is the figure somebody opens this screen
            // to find: what has gone out this month. Then what came in, then what
            // is left of the two. That order is the arithmetic's order, and it
            // makes the third figure readable as an answer to the first two rather
            // than as a fourth thing on the screen.
            stat({ label: t("home.monthExpenses"), value: formatMoney(expenses, currency), icon: "moneyOut" }),
            stat({ label: t("home.monthIncome"), value: formatMoney(income, currency), icon: "moneyIn" }),
            // The one figure on this screen that can be genuinely bad news, so it
            // is the one allowed to be in the red — and the one that has to CARRY
            // its sign. A month of 42.50 spent and nothing earned prints
            // "−42.50" here, not "42.50": the sign is the answer, and the unsigned
            // formatter that every other amount here uses would answer the opposite
            // question.
            stat({
                label: t("home.monthRemaining"),
                value: formatSignedMoney(net, currency),
                icon: "scale",
                tone: net < 0 ? "danger" : ""
            }),
            // What is still owed, as ONE position rather than the two totals it
            // came from: positive means the debt is owed to the user, negative
            // means they owe it. It carries its sign for the same reason the
            // figure above does, and it is a balance rather than a flow, so it is
            // not part of the month's arithmetic and is never added into `net`.
            stat({
                label: t("home.monthDebts"),
                value: formatSignedMoney(debts?.net ?? 0, currency),
                icon: "scale",
                tone: (debts?.net ?? 0) < 0 ? "danger" : ""
            })
        ));
    },

    // ---- Time today, against the day this user usually keeps -----------------

    renderHours(data) {
        const part = this.parts?.hours;
        if (!part) return;
        const { box, section } = part;
        if (!data) return box.replaceChildren(h("p", { class: "muted small" }, t("common.loading")));

        const { today, expected } = data;
        // No time today and no history to compare it against: there is no
        // comparison to draw, and "0m against an average of 0m" would be two
        // absences dressed up as a measurement.
        if (today.totalMs === 0 && !expected) {
            section.hidden = true;
            return box.replaceChildren();
        }
        section.hidden = false;

        fill(box,
            // The expected figure is derived and never configured — see
            // expectedDailyMs — so the bar is drawn only when there is an average
            // to put a mark on. Without one the day's total stands on its own,
            // which is the honest reading of a first day.
            expected ? timeMeter({ todayMs: today.totalMs, expectedMs: expected.totalMs }) : null,
            h("p", { class: "muted small" }, todayLine(today)),
            // Where the average came from, in words. A figure the user cannot trace
            // back to anything is a figure they have to take on trust, and this one
            // is derived rather than configured — so it says so.
            expected ? h("p", { class: "muted small" }, t("home.expectedNote")) : null
        );
    },

    // ---- Today: the tasks worth putting in front of the user -----------------

    renderTasks(data) {
        const box = this.tasksBox;
        const section = this.tasksSection;
        if (!box || !section) return;
        if (!data) return box.replaceChildren(h("p", { class: "muted small" }, t("common.loading")));

        // The empty state is a real answer — "you have no tasks" is what this
        // section is for — so unlike the summary blocks it is shown rather than
        // hidden. What is never shown is the heading over an empty box.
        section.hidden = false;

        const tasks = data.tasks;
        if (tasks.length === 0) {
            box.replaceChildren(emptyState(t("home.noTasks"), {
                icon: "tasks",
                action: action({ label: t("home.addFirstTask"), icon: "plus", tone: "primary", href: "/tasks/new" })
            }));
            return;
        }

        fill(box, list(...tasks.map(task => listRow({
            href: `/tasks/${task.id}`,
            title: task.title,
            meta: [
                badge(formatShort(task.estimatedMs), { icon: "target" }),
                // A task whose planned day has gone by says so. There is no
                // "today" column to put it in, and a date the user set themselves
                // is not something to leave for them to remember.
                lateBadge(task)
            ],
            actions: [
                rowAction({ label: t("home.startTask"), icon: "play", tone: "primary", onClick: () => this.start(task.id) }),
                rowAction({
                    label: t("home.closeTask"),
                    icon: "check",
                    onClick: async () => {
                        await closeTask(task);
                        this.loadGlance();
                    }
                })
            ]
        }))));
    },

    // ---- The last few things that were added ---------------------------------

    renderRecent(data) {
        const part = this.parts?.recent;
        if (!part) return;
        const { box, section } = part;
        if (!data) return box.replaceChildren(h("p", { class: "muted small" }, t("common.loading")));

        // Five, which is the limit `recentAdditions` derives with — a sixth is a
        // list that has stopped being a glance, and every one of them is one tap
        // from the screen this block's door leads to.
        const recent = data.recent;
        section.hidden = recent.length === 0;
        if (recent.length === 0) return box.replaceChildren();

        fill(box, list(...recent.map(item => {
            const target = RECENT_TARGETS[item.kind];
            return listRow({
                // A kind with no screen of its own is drawn as a plain row rather
                // than as a link that goes nowhere. Today every kind has one; the
                // fallback is here so the next service added is a one-line change
                // here rather than a row that silently does nothing.
                href: target ? target.href(item.id) : null,
                icon: target?.icon ?? "note",
                title: recentTitle(item),
                meta: [badge(formatTime(item.at), { icon: "clock" })]
            });
        })));
    },

    async start(taskId) {
        try {
            await sessionService.start(taskId);
            router.navigate("/session");
        } catch (e) {
            toast.show(`error.${e?.code || "unexpected"}`);
        }
    }
};

/**
 * The door out of a block, into the screen it summarises.
 *
 * Icon-only, with the destination's OWN name from the navigation's one label
 * table as the tooltip and the accessible name. Not a word: the section header
 * already says what the block is, and "Tasks" printed at the end of a heading
 * that says "Today's tasks" is the same fact twice — while an unlabelled chevron
 * is nothing a screen reader can announce.
 *
 * Reading the label out of NAV_LABELS rather than passing one in is the point: the
 * home screen and the menu call the same screen by the same name because there is
 * only one table, not because two files happened to agree.
 *
 * The one destination that is not in that table is /session — the session in
 * progress, which is a screen and not a section, so it is not in the menu and has
 * no row of its own. Its name is passed for exactly that reason: there is no
 * second table for the handful of screens that are not sections.
 */
function goTo(href, labelKey = NAV_LABELS[href]) {
    const label = t(labelKey);
    return action({ label: null, icon: "chevronRight", href, title: label, ariaLabel: label });
}

/**
 * Is this task past a day that has already gone by?
 *
 * The decision, separated from the badge, because it is a fact about a DATE and
 * the badge is a claim about it — and because a rule this app states in words
 * should be testable without a DOM. The boundary is the START of today rather than
 * the clock: a task planned for 23:00 tonight is planned for today, and calling it
 * overdue at nine in the morning would be the app disagreeing with the user's own
 * plan about the same day.
 *
 * A task with no planned date has nothing to be late for, which is not the same as
 * being on time — which is why this answers false and the badge is omitted, rather
 * than one answering "on time" for a task nobody scheduled.
 */
export function isLate(plannedAt, now = Date.now()) {
    if (!Number.isFinite(plannedAt)) return false;
    return plannedAt < startOfDay(now);
}

/**
 * Put children in a box, dropping the ones that are not there.
 *
 * `h()` filters null out of its own children, and `replaceChildren` does NOT: it is
 * the native DOM method, it does not flatten an array, and it stringifies anything
 * that is not a Node. So `box.replaceChildren(maybeBar, line, maybeNote)` with a
 * null in the middle writes the literal text "null" into the page — which is not a
 * cosmetic failure on a screen whose whole rule is "a block says only what is
 * true".
 *
 * Spread, and filter, in one place, so a block that draws conditionally does not
 * have to remember.
 */
function fill(box, ...children) {
    box.replaceChildren(...children.flat(Infinity).filter(Boolean));
}

// "Overdue", or nothing. The one badge on this screen that can be bad news, so it
// is also the only one allowed to be in the red.
function lateBadge(task, now = Date.now()) {
    if (!isLate(task.plannedAt, now)) return null;
    return badge(t("home.dueLate"), { icon: "calendar", tone: "danger" });
}

// Today's total in one sentence. The two plural forms are separate keys rather
// than a count-aware format because the count is a number and the noun has to
// agree with it in Arabic as well as English.
function todayLine(today) {
    if (today.count === 0) return t("home.todayEmpty");
    return (today.count === 1
        ? t("home.todaySession", { count: today.count, total: formatShort(today.totalMs) })
        : t("home.todaySessions", { count: today.count, total: formatShort(today.totalMs) }));
}

/**
 * Once a minute, on the minute.
 *
 * The wall clock turns once a minute, so a one-second tick would be motion for its
 * own sake. Each tick schedules the next for the minute it has just entered rather
 * than running on a fixed interval, because an interval accumulates drift and a
 * clock up to half a minute late is a clock nobody trusts.
 *
 * Returns the cancel function, which unmount() calls — a page that navigated away
 * must not keep a timer alive writing into a node nobody is looking at.
 */
function startClock(write) {
    let timer = null;
    const tick = () => {
        const now = Date.now();
        write(now);
        // +250ms, so the tick lands after the minute has turned rather than on its
        // first millisecond, where a device with a coarse clock would still be
        // showing the previous minute.
        timer = setTimeout(tick, 60000 - (now % 60000) + 250);
    };
    tick();
    return () => clearTimeout(timer);
}

// How each service's record is reached from the "recently added" list, and the
// glyph it is drawn with. One table for both, because a row whose link opens one
// screen and whose icon belongs to another is a row nobody can scan.
const RECENT_TARGETS = {
    task: { icon: "tasks", href: id => `/tasks/${id}` },
    session: { icon: "clock", href: id => `/sessions/${id}` },
    transaction: { icon: "wallet", href: id => `/finance/transactions/${id}` },
    later: { icon: "bookmark", href: id => `/later/${id}` },
    routine: { icon: "repeat", href: id => `/routines/${id}` },
    page: { icon: "file", href: id => `/pages/${id}` }
};

// What a row is labelled with. A free session and an untitled page have no name of
// their own, so each is named by the thing it is — and a row with no label at all
// is worse than one that says "Untitled", because an empty row is a gap in a list
// the reader is scanning.
function recentTitle(item) {
    if (item.kind === "session") return item.title || t("session.free");
    if (item.kind === "later") return laterLabel(item) ?? t("later.untitled");
    if (item.kind === "page") return item.title || t("pages.untitled");
    return item.title || t("common.untitled");
}

// The live session, as a line rather than a stage: the stage belongs to the
// session page, and the home screen's job here is to say "one is running" and get
// out of the way. The elapsed figure is the one that moves, so it is the one that
// is here — a card that shows a frozen 0:00 would be worse than nothing.
function runningSummary(active) {
    const elapsed = active.segments.reduce(
        (a, s) => a + Math.max(0, (s.end ?? Date.now()) - s.start),
        0
    );
    return h("div", { class: "home-running" },
        h("a", { class: "home-running-link", href: "/session" },
            h("span", { class: "home-running-title own-text" }, active.taskTitle || t("session.free")),
            h("span", { class: "home-running-time number" }, formatShort(elapsed))
        ),
        badge(t(`session.${active.status}`), { icon: "clock" })
    );
}

// Exported for the tests, which need this screen's decisions about what to show
// without a DOM to show them in.
export { todayLine, RECENT_TARGETS, startClock };