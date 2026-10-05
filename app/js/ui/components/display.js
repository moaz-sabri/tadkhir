// The two display shapes the home screen and the session page need, kept in
// the design system beside the rest of the kit rather than written by the pages
// that use them.
//
// Both exist because a figure that matters deserves more than a number in a
// grid cell, and both had nowhere to live:
//
//   timeMeter  — today against the user's own average day, as one bar with a
//                mark on it. The home screen answers "how is today going?" with
//                a shape, because "2h 10m of an expected 3h" is a comparison
//                two numbers can only state, not show.
//   timeStage  — the session counter as a stage. The session page is looked at
//                from across a desk, so the time is the page rather than part
//                of it: one number, filling whatever viewport there is.
//
// Same rules as ui.js: an icon is a signal, a word is a confirmation, and every
// class name here has a rule in the stylesheet.

import { h, flash } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { uiIcon } from "../icons.js";
import { formatShort, formatTime, formatDateLong } from "../../domain/time.js";

/**
 * One bar: today's recorded time against the day the user usually keeps.
 *
 * A single bar, not a chart. A fortnight of columns answered "have I been using
 * this lately?", which is a question for Reports, and answering it on the home
 * screen put fourteen shapes between the person and the two numbers they came
 * to read. What is left is the comparison itself, and it fits in one line of
 * screen: the filled part is today, the tick is the expected day, and the two
 * figures underneath say both in words for anyone who cannot see either.
 *
 * The scale is the LARGER of the two, times a little, so the mark is always on
 * the bar and never off the end of it. That means a day well past the average
 * fills the whole width and simply reads as full — which is the honest shape for
 * "more than usual", where clamping would invent a ceiling the user never set.
 *
 * `expected` is null when there is no history to derive an average from (see
 * expectedDailyMs), and then the bar is not drawn at all: a bar with no mark on
 * it is a bar that says nothing, and the caller shows the day's total on its own
 * instead.
 */
export function timeMeter({ todayMs = 0, expectedMs = null } = {}) {
    const peak = Math.max(todayMs, expectedMs ?? 0) * 1.15 || 1;
    const fill = Math.round((todayMs / peak) * 100);
    const mark = expectedMs == null ? null : Math.round((expectedMs / peak) * 100);

    return h("div", { class: "time-meter" },
        h("div", {
            class: "time-meter-track",
            // One image, not a graph: the two figures are already written out
            // underneath in words, so this is the shape of them rather than a
            // second, less precise way of reading the same thing.
            role: "img",
            "aria-label": t("home.meterLabel", {
                today: formatShort(todayMs),
                expected: formatShort(expectedMs ?? 0)
            })
        },
            h("span", { class: "time-meter-fill", style: `--fill: ${fill}%` }),
            mark == null ? null : h("span", { class: "time-meter-mark", style: `--mark: ${mark}%` })
        ),
        h("div", { class: "time-meter-axis" },
            h("span", {}, t("home.today")),
            h("span", {}, t("home.expectedOf", { total: formatShort(expectedMs ?? 0) }))
        )
    );
}

/**
 * The session counter as a stage.
 *
 * Everything a screen needs to show an elapsed time as the subject of the page
 * rather than a widget inside one: the counter, the status, the task title, and
 * an optional progress ring. The numbers are written by the session panel on
 * every tick, so nothing here holds a timer.
 *
 * THE SIZE IS DERIVED, NOT CHOSEN. This is the whole design, and it is the one
 * thing about it that is easy to get wrong:
 *
 * A `clamp()` against the viewport sizes the counter for the string you
 * measured, and an elapsed time is not one string. "0:04" is four characters
 * and 1.6em wide; "72:00:00" is eight and 3.2em wide. So a counter sized while
 * the session is young fits perfectly for an hour and then spills out through
 * the ring it was supposed to be inside — twice the width it was drawn for, on
 * exactly the display it was drawn to be read from. Nothing about that failure
 * is visible until the digits arrive.
 *
 * So the counter's size is computed from two facts and nothing else: how much
 * room there is, and how many characters are in it. The room is one custom
 * property (`.stage` knows the size of the box), and the character count is one
 * attribute written here — `data-len` — which the stylesheet turns into the
 * string's width in em. The counter then divides the available room by that
 * width, which is the largest font size that cannot overflow, by construction,
 * for every string the app can produce.
 *
 * A progress ring rather than a bar, for one reason: at stage size the bar is
 * 400px wide and 6px tall, which shows a percentage and nothing else. The ring
 * is the one shape whose AREA can carry the figure, so the estimate reads from
 * across the room and not only from up close.
 */
export function timeStage({ title = null, status = null, icon = null, progress = false } = {}) {
    const counter = h("div", { class: "stage-counter number", role: "timer" }, "0:00");
    const statusEl = h("div", { class: "stage-status" }, status || "");
    const titleEl = h("div", { class: "stage-title" },
        icon ? uiIcon(icon, { className: "icon icon-sm" }) : null,
        title || ""
    );

    // The ring: a conic gradient driven by one custom property, because SVG
    // stroke-dasharray would need a second element and a viewBox, and this app
    // has no chart code at all.
    const ringFill = h("div", { class: "stage-ring-fill" });
    const ringPct = h("div", { class: "stage-ring-pct number" }, "0%");
    const ring = h("div", { class: "stage-ring", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" },
        ringFill,
        h("div", { class: "stage-ring-hole" },
            counter,
            ringPct
        )
    );

    // The moment that figure is being measured at: the time of day, and the day
    // it is on. It is the one thing the elapsed counter cannot tell you, and it is
    // the thing you need on this screen specifically — an hour of work begun at
    // 23:50 and an hour begun at 09:50 are the same number, and at 20 minutes
    // past a midnight boundary only one of them is still the same day.
    //
    // UNDER the counter and not in the head: the head already answers two
    // questions (what, and in what state), and the head is where the eye starts.
    // Down here it reads as the caption to the number — this much time, counted
    // to now, on this day — which is the order a person reads a timecard in.
    const nowTimeEl = h("span", { class: "stage-now-time number" });
    const nowDateEl = h("span", { class: "stage-now-date" });
    const nowEl = h("div", { class: "stage-now" },
        nowTimeEl,
        // A separator that is punctuation, not a word: hidden from anything
        // reading the two values out loud, so a screen reader says the time and
        // then the date rather than announcing a middot between them.
        h("span", { class: "stage-now-sep", "aria-hidden": "true" }, "·"),
        nowDateEl
    );

    const stage = h("div", {
        class: "stage",
        // The two facts the stylesheet needs and cannot work out for itself.
        // `data-progress` because a free session has no ring, so its counter is
        // sized against the full width instead of against a hole. `data-len`
        // because the width of an elapsed time in em depends on how many
        // characters it has, and that is the one thing only the text knows.
        "data-progress": progress ? "true" : "false",
        "data-len": "4"
    },
        h("div", { class: "stage-head" }, titleEl, statusEl),
        progress ? ring : counter,
        nowEl
    );

    // The character count only changes when the hour or minute column grows, so
    // this is not a per-tick write: the attribute is set on the first tick and
    // then stays put for the rest of the session, twice at most.
    let lastLen = -1;
    const setLen = n => {
        if (n === lastLen) return;
        lastLen = n;
        stage.setAttribute("data-len", String(n));
    };
    setLen(4);

    // The wall clock changes once a minute, so a caller can call this as often as
    // it likes — which it does, on a one-second tick — and the DOM is touched
    // only when the minute actually turns over. Same shape as the guard above and
    // for the same reason.
    let lastNow = "";

    return {
        element: stage,
        counter,
        /** The percentage, only rendered when the ring is. */
        pct: ringPct,
        ring,
        /**
         * Write the counter, and keep the size honest with what it now says.
         * This is the call the panel makes once a second, so it does one string
         * length and at most one attribute write.
         */
        setCounter(text) {
            counter.textContent = text;
            setLen(text.length);
        },
        setPercent(pct) {
            if (!progress) return;
            const clamped = Math.max(0, Math.min(100, pct));
            // Through the CSSOM, not the attribute: this app's CSP has no
            // `unsafe-inline` for styles, so a `style` attribute is silently
            // refused and the ring would never move.
            ringFill.style.setProperty("--progress", `${clamped}%`);
            ringPct.textContent = `${clamped}%`;
            ring.setAttribute("aria-valuenow", String(clamped));
        },
        setStatus(text) { statusEl.textContent = text || ""; },
        /**
         * The time of day and the date, under the counter.
         *
         * Formatted here rather than by the caller so the stage owns what it
         * shows: the panel has no way to render "now" and no reason to know the
         * stage is going to.
         */
        setNow(ts) {
            const time = formatTime(ts);
            const date = formatDateLong(ts);
            const key = `${time} ${date}`;
            if (key === lastNow) return;
            lastNow = key;
            nowTimeEl.textContent = time;
            nowDateEl.textContent = date;
        },
        setTitle(text) {
            titleEl.textContent = "";
            if (icon) titleEl.append(uiIcon(icon, { className: "icon icon-sm" }), text || "");
            else titleEl.textContent = text || "";
        },
        /**
         * One pulse of the whole stage, for a state the user just caused.
         *
         * The stage is the largest thing on the screen and the thing the page was
         * opened for, so it is the right place to answer "the timer changed" —
         * and answering it anywhere else (a toast, a colour on the button) would
         * be a second shape for the same idea. The pulse is the stylesheet's; see
         * flash() in dom.js for why it is an attribute and not an animation call.
         */
        flash(kind) { flash(stage, kind); }
    };
}
