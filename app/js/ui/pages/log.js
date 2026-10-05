import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { bus } from "../../app/bus.js";
import { logService } from "../../services/log-service.js";
import { formatShort, formatTime, dayLabel } from "../../domain/time.js";
import { formatMoney } from "../../domain/money.js";
import { MONEY_ICON_NAMES } from "../icons.js";
import { laterLabel } from "../../domain/later.js";
import { counterRatio } from "../components/routine-row.js";
import {
    page,
    pageHead,
    pageSection,
    list,
    listRow,
    emptyState,
    badge
} from "../components/ui.js";
import { selectControl, caption } from "../components/fields.js";

// The Log: what happened, day by day.
//
// A tool over the services rather than a service of its own, which is why it
// holds nothing — see log-service.js. What it is FOR is the one question none of
// the services answers on its own: not "what is due" and not "what is open", but
// "what did I actually do", across all of them at once, in the order it happened.
//
// Two decisions, and both are about restraint:
//
//   - DAYS, not a flat list of timestamps. A person remembers an activity in
//     days; a wall of clock times is a wall of noise. A day with nothing in it is
//     not shown at all, so the headings are only ever over something.
//   - A window, not all of history. Thirty days is a screenful and about a month;
//     past that the answer to "what did I do" is Reports, which is built for
//     aggregates rather than for a day-by-day reading.
//
// There is deliberately NO filter by kind. Five kinds and one unfiltered list,
// because a person who has to choose before they can look is a person who does
// not look — and the rows carry their own glyph and their own figure, so a mixed
// list is still readable. Narrowing by kind is what a person asks for when they
// already know what they are looking for, and Reports is the screen for that.
export const logPage = {
    title: () => t("nav.log"),

    async mount(root) {
        // Page state, not URL: the router matches paths only, so putting the
        // window in the address would lose the selection on every re-read.
        let days = 30;

        const body = h("div", { class: "log-days" });

        const { select, element } = selectControl({
            options: LOG_WINDOWS.map(w => ({ value: String(w.days), label: t(w.key) })),
            value: String(days),
            ariaLabel: t("log.window")
        });
        select.addEventListener("change", () => {
            days = Number(select.value) || 30;
            this.render(body, days);
        });

        root.append(page(
            pageHead({
                title: t("nav.log"),
                icon: "history",
                // The window picker is the app's select control, in the header's
                // action slot — the same slot a "New" button occupies elsewhere,
                // because it is the one thing you can change about this screen.
                actions: h("label", { class: "head-filter" },
                    caption(t("log.window")),
                    element
                )
            }),
            body
        ));

        await this.render(body, days);

        // The log reads records that belong to six other services, so it redraws
        // on the one signal that means "any of them changed" — not on a store slice,
        // which would mean choosing one service to watch and hoping it was the one
        // that moved. The bus carries the same signal the store itself listens to,
        // so this is a redraw and not a re-read of the world.
        const off = bus.on("data-changed", () => this.render(body, days));
        this.off = off;
    },

    unmount() {
        this.off?.();
        this.off = null;
    },

    async render(body, days) {
        let grouped = [];
        try {
            grouped = await logService.list({ days });
        } catch (e) {
            // A read that failed says nothing about what happened. The previous
            // drawing is left alone rather than replaced with an error, because a
            // wrong history is worse than an old one.
            console.warn("log read failed:", e);
            return;
        }
        // Guarded on the node: the read is a transaction over six stores and the
        // reader can navigate away while it is in flight.
        if (!document.body.contains(body)) return;

        if (grouped.length === 0) {
            body.replaceChildren(emptyState(t("log.empty"), { icon: "history" }));
            return;
        }
        // Spread, not the array: `replaceChildren` is the native DOM method and
        // does not flatten what it is given.
        body.replaceChildren(...grouped.map(day => this.day(day)));
    },

    // One day: a heading with the day's name, and the lines under it.
    day({ day, at, rows }) {
        const now = Date.now();
        const totalMs = rows
            .filter(r => r.kind === "session")
            .reduce((a, r) => a + (r.actualMs || 0), 0);

        return pageSection({
            title: dayLabel(at, now, { today: t("common.today"), yesterday: t("common.yesterday") }),
            // The day's recorded time, when there is any. It is the one number a
            // reader wants about a day before reading the day, and it is the same
            // total the reports page would produce from the same sessions.
            icon: "calendar",
            action: totalMs > 0 ? badge(formatShort(totalMs), { icon: "clock" }) : null,
            body: list(...rows.map(row => this.row(row)))
        });
    },

    // One line. Every kind opens the record it came from, because a log whose rows
    // are decoration is a list of claims; and every line carries the time it
    // happened, because inside a day that is the only ordering there is.
    row(item) {
        return listRow({
            href: LOG_TARGETS[item.kind]?.href(item.id) ?? null,
            icon: LOG_ICONS[item.kind] ?? "note",
            title: logTitle(item),
            meta: [
                logBadge(item),
                badge(formatTime(item.at), { icon: "clock" })
            ].filter(Boolean)
        });
    }
};

// How long a window to offer, and what each is called. Three, and no more: a
// couple of weeks to check something recent, a month to be the default, and a
// quarter for the times a person is actually looking for something they remember
// doing. Beyond that the reports page is the honest place to look, and offering
// "all time" here would promise a list this screen is not built to draw.
const LOG_WINDOWS = [
    { days: 14, key: "log.window14" },
    { days: 30, key: "log.window30" },
    { days: 90, key: "log.window90" }
];

// Where each kind of line opens, and what it is drawn with. One table for both,
// because a row whose link opens one screen and whose glyph belongs to another is
// a row nobody can scan.
const LOG_TARGETS = {
    session: { icon: "clock", href: id => `/sessions/${id}` },
    transaction: { icon: "wallet", href: id => `/finance/transactions/${id}` },
    routine: { icon: "repeat", href: id => `/routines/${id}` },
    task: { icon: "tasks", href: id => `/tasks/${id}` },
    later: { icon: "bookmark", href: id => `/later/${id}` }
};

const LOG_ICONS = Object.fromEntries(
    Object.entries(LOG_TARGETS).map(([kind, v]) => [kind, v.icon])
);

// The one figure on the line, when the kind has one. A session says how long it
// ran, a transaction says which way and how much, a counter says how far it got —
// and the rest say nothing, because a row with an empty badge in it is a gap in a
// list somebody is scanning.
function logBadge(item) {
    if (item.kind === "session") {
        return item.status === "cancelled"
            ? badge(t("log.cancelled"), { icon: "close", tone: "danger" })
            : badge(formatShort(item.actualMs || 0), { icon: "clock" });
    }
    if (item.kind === "transaction") {
        return badge(formatMoney(item.amount, item.currency), {
            icon: MONEY_ICON_NAMES[item.moneyType] ?? "wallet"
        });
    }
    if (item.kind === "routine") {
        return badge(counterRatio(item.count, item.target), { icon: "target" });
    }
    return null;
}

// What a line is called. A free session, an untitled page and a note with no title
// have no name of their own, and each is named by the thing it is — a log line
// with no label reads as a rendering failure rather than as a record.
function logTitle(item) {
    if (item.kind === "session") return item.title || t("session.free");
    if (item.kind === "later") return laterLabel(item) ?? t("later.untitled");
    return item.title || t("common.untitled");
}

export { LOG_TARGETS, LOG_WINDOWS };
