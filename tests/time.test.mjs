import test from "node:test";
import assert from "node:assert/strict";
import {
    formatClock,
    formatCountdown,
    formatOvertime,
    formatShort,
    dayKey,
    startOfDay,
    dayLabel,
    toDateInputValue,
    fromDateInputValue,
    toDateTimeInputValue,
    fromDateTimeInputValue,
    formatDate,
    formatDateTime,
    formatTime,
    formatDateLong,
} from "../app/js/domain/time.js";

test("formatClock pads minutes and hours", () => {
    assert.equal(formatClock(0), "0:00");
    assert.equal(formatClock(90_000), "1:30");
    assert.equal(formatClock(3_661_000), "1:01:01");
    assert.equal(formatClock(59_999), "0:59");
});

test("formatClock clamps negatives to zero", () => {
    assert.equal(formatClock(-5_000), "0:00");
});

test("formatCountdown rounds up to the second", () => {
    assert.equal(formatCountdown(90_001), "1:31");
    assert.equal(formatCountdown(0), "0:00");
    assert.equal(formatCountdown(-1), "0:00");
});

test("formatOvertime prefixes a plus", () => {
    assert.equal(formatOvertime(0), "+0:00");
    assert.equal(formatOvertime(65_000), "+1:05");
    assert.equal(formatOvertime(-5_000), "+0:00");
});

test("formatShort uses compact units", () => {
    assert.equal(formatShort(30_000), "<1m");
    assert.equal(formatShort(600_000), "10m");
    assert.equal(formatShort(3_660_000), "1h 1m");
    assert.equal(formatShort(7_200_000), "2h");
});

test("formatShort reports an exact zero as zero, not as '<1m'", () => {
    // A report over an empty window has recorded no time. Claiming "<1m" there
    // would assert a session had happened.
    assert.equal(formatShort(0), "0m");
    assert.equal(formatShort(-1), "0m");
    // Anything under a minute that is not zero is still honestly "<1m".
    assert.equal(formatShort(59_999), "<1m");
});

test("dayKey / startOfDay / dayLabel agree for local dates", () => {
    const now = new Date(2026, 0, 5, 14, 30).getTime();
    assert.equal(dayKey(now), "2026-01-05");
    assert.equal(startOfDay(now), new Date(2026, 0, 5).getTime());
    assert.equal(dayLabel(new Date(2026, 0, 5, 9, 0).getTime(), now), "Today");
    assert.equal(dayLabel(new Date(2026, 0, 4, 23, 0).getTime(), now), "Yesterday");
    // Anything older is a real date formatted for the reader's locale, never a
    // raw YYYY-MM-DD key. The exact digits depend on the host locale, so the
    // assertion is that it is a formatted date rather than the key itself.
    const older = dayLabel(new Date(2026, 0, 1, 12, 0).getTime(), now);
    assert.notEqual(older, "2026-01-01");
    assert.notEqual(older, dayKey(new Date(2026, 0, 1, 12, 0).getTime()));
});

test("dayLabel takes the two relative words from the caller", () => {
    const now = new Date(2026, 0, 5, 14, 30).getTime();
    const labels = { today: "اليوم", yesterday: "أمس" };
    assert.equal(dayLabel(new Date(2026, 0, 5, 9, 0).getTime(), now, labels), "اليوم");
    assert.equal(dayLabel(new Date(2026, 0, 4, 23, 0).getTime(), now, labels), "أمس");
});

test("a date input keeps the day and drops the time", () => {
    const t = new Date(2026, 8, 26, 14, 35, 42, 500).getTime();
    assert.equal(toDateInputValue(t), "2026-09-26");
    // Reading a date-only control back gives local midnight, never the clock.
    assert.equal(fromDateInputValue("2026-09-26"), new Date(2026, 8, 26).getTime());
    assert.notEqual(fromDateInputValue("2026-09-26"), t);
});

test("a datetime input keeps the local wall clock to the minute", () => {
    const t = new Date(2026, 8, 26, 14, 35, 42, 500).getTime();
    assert.equal(toDateTimeInputValue(t), "2026-09-26T14:35");
    // Seconds are below the control's step, so they do not survive the trip.
    assert.equal(fromDateTimeInputValue("2026-09-26T14:35"), new Date(2026, 8, 26, 14, 35).getTime());
});

test("a datetime input pads single-digit hours and minutes", () => {
    assert.equal(toDateTimeInputValue(new Date(2026, 0, 2, 9, 5).getTime()), "2026-01-02T09:05");
    assert.equal(toDateTimeInputValue(new Date(2026, 11, 31, 23, 59).getTime()), "2026-12-31T23:59");
});

test("datetime conversion is local, never a UTC shift", () => {
    // The regression this guards: parsing the string with `new Date(...)`
    // would treat it as UTC and move the moment by the offset.
    const midnight = new Date(2026, 8, 26, 0, 0, 0, 0).getTime();
    assert.equal(fromDateTimeInputValue("2026-09-26T00:00"), midnight);
    assert.equal(fromDateTimeInputValue(toDateTimeInputValue(midnight)), midnight);
});

test("datetime input rejects what it cannot read", () => {
    for (const bad of ["", "   ", null, undefined, "2026-09-26", "26/09/2026 14:35", "not-a-date"]) {
        assert.equal(fromDateTimeInputValue(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
    assert.equal(toDateTimeInputValue(NaN), "");
    assert.equal(toDateTimeInputValue(null), "");
});

test("formatDateTime shows the date and the time, formatDate only the date", () => {
    const t = new Date(2026, 8, 26, 14, 35).getTime();
    const day = formatDate(t);
    const stamp = formatDateTime(t);
    assert.ok(stamp.startsWith(day), "the date is the head of the stamp");
    assert.notEqual(stamp, day, "the time is added, not dropped");
    // 12h vs 24h, U+0660 vs ASCII digits: all locale choices, so only the
    // shape of a clock is asserted — a colon and at least two digits.
    const clock = stamp.slice(day.length).trim();
    assert.ok(clock.includes(":"), `expected a clock time in "${stamp}"`);
    assert.match(clock, /\p{Nd}{2}/u, `expected digits in "${stamp}"`);
    assert.equal(formatDate(NaN), "—");
    assert.equal(formatDateTime(NaN), "—");
});

// The wall clock and the long date are the two figures on a running session that
// are not the elapsed one. An hour of work begun at 23:50 and an hour begun at
// 09:50 are the same number in formatClock, and the only thing that tells them
// apart is the time of day — which is why these cannot be a day key, a locale
// date, or anything the reader has to decode.

test("formatTime is the clock, alone, with no date in front of it", () => {
    const t = new Date(2026, 8, 26, 14, 35).getTime();
    const clock = formatTime(t);
    assert.ok(clock.includes(":"), `expected a clock time in "${clock}"`);
    assert.match(clock, /\p{Nd}{2}/u, `expected digits in "${clock}"`);
    // The regression this guards: returning formatDateTime here would put
    // "26/09/2026 " in front of every clock on the stage, twice a day, on a
    // line whose whole job is to be readable at a glance.
    assert.doesNotMatch(clock, /\p{Nd}{4}/u, `formatTime must not carry a year: "${clock}"`);
    assert.equal(formatTime(NaN), "—");
});

test("formatDateLong names the day, so a session past midnight is not misread", () => {
    const t = new Date(2026, 8, 26, 14, 35).getTime();
    const long = formatDateLong(t);
    // 12h vs 24h and ASCII vs Arabic-Indic digits are locale choices, so only the
    // shape is asserted: the day, the month, and the year are all named, and the
    // weekday is a word rather than a number.
    assert.match(long, /\p{Nd}/u, `expected a day or a month in "${long}"`);
    assert.ok(!formatDate(t).includes(long), "the long form is not the numeric one");
    // 26 September 2026 was a Saturday — a name the numeric form cannot carry at
    // all, and the one that separates "started yesterday evening" from
    // "started today", where the numbers are identical.
    assert.ok(/\p{L}/u.test(long), `expected a written month or weekday in "${long}"`);
    assert.equal(formatDateLong(NaN), "—");
});

test("the two date forms never disagree about which day a moment is on", () => {
    // The stage shows the long date under the clock; the sessions list and the
    // session detail show the numeric one beside the same sessions. If the two
    // could name different days for one timestamp, the app would be showing two
    // answers to the only question the date is there to answer.
    //
    // Swept across every hour of the day because the disagreement would not be
    // uniform: it is the kind that only shows up in the evening, which is exactly
    // when sessions are actually being run.
    //
    // The day is located by asking the LOCALE for it, never by reading it off
    // the string by position. "The first one-or-two-digit run is the day" holds
    // in `26/09/2026` and fails in `09/26/2026`, which is the same code on a
    // machine whose locale puts the month first — so the check below asks
    // Intl.DateTimeFormat for the `day` part of the same options the function
    // under test uses, and asserts that value is among the numbers the function
    // printed. Locale digits are folded to ASCII first, since a reader whose
    // locale writes ٢٦ has a day number no amount of literal comparison finds.
    const digits = s => s.replace(/\p{Nd}/gu, d => String(d.codePointAt(0) & 0x0f));
    const numbersIn = s => digits(s).split(/[^\d]+/).filter(Boolean);
    const dayOf = (ts, options) => digits(
        new Intl.DateTimeFormat(undefined, options)
            .formatToParts(ts)
            .find(p => p.type === "day").value
    );

    const numeric = { day: "2-digit", month: "2-digit", year: "numeric" };
    const long = { weekday: "long", day: "numeric", month: "long" };

    for (let h = 0; h < 24; h++) {
        const t = new Date(2026, 8, 26, h, 30).getTime();
        assert.ok(numbersIn(formatDate(t)).includes(dayOf(t, numeric)),
            `formatDate lost the day at ${h}:30 — ${formatDate(t)}`);
        assert.ok(numbersIn(formatDateLong(t)).includes(dayOf(t, long)),
            `formatDateLong lost the day at ${h}:30 — ${formatDateLong(t)}`);
    }
});