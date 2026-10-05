const n = new Intl.NumberFormat(undefined, { numberingSystem: "latn", useGrouping: false });

export const DAY_MS = 86400000;

export function formatClock(ms) {
    let s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    s %= 3600;
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return h
        ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
        : `${m}:${String(sec).padStart(2, "0")}`;
}

export function formatCountdown(ms) {
    return ms > 0 ? formatClock(Math.ceil(ms / 1000) * 1000) : "0:00";
}

export function formatOvertime(ms) {
    return `+${formatClock(Math.max(0, Math.floor(ms / 1000) * 1000))}`;
}

export function formatShort(ms) {
    let s = Math.max(0, Math.floor(ms / 1000));
    // An exact zero is a real measurement, not "too small to say": a report for
    // an empty month has genuinely recorded no time, and showing it as "<1m"
    // claimed a session had happened. Written out rather than formatted, so a
    // locale using Arabic-Indic digits does not render it as "٠m".
    if (s === 0) return "0m";
    // Anything under a minute that is not zero is still "<1m", which is the
    // honest answer for a 30-second session.
    if (s < 60) return "<1m";
    let m = Math.floor(s / 60);
    if (m < 60) return `${n.format(m)}m`;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${n.format(h)}h ${n.format(r)}m` : `${n.format(h)}h`;
}

export function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function startOfDay(now = Date.now()) {
    const d = new Date(now);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function startOfMonth(now = Date.now()) {
    const d = new Date(now);
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

// Local Y-M-D, same shape as dayKey, so an <input type="date"> round-trips
// through the same calendar the rest of the app reads.
export function toDateInputValue(ts) {
    if (!Number.isFinite(ts)) return "";
    return dayKey(ts);
}

// `new Date("2026-10-01")` is parsed as UTC by the platform, which shifts the
// day in negative offsets. Build the local date explicitly instead.
export function fromDateInputValue(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? "").trim());
    if (!m) return null;
    const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    return Number.isFinite(ts) ? ts : null;
}

// The same contract for a moment rather than a day: local wall-clock, the shape
// <input type="datetime-local"> round-trips. Minutes are the granularity the
// control offers by default (step 60), so seconds are dropped on the way in and
// ignored on the way out — anything after HH:mm is a step we do not use.
export function toDateTimeInputValue(ts) {
    if (!Number.isFinite(ts)) return "";
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${dayKey(ts)}T${hh}:${mm}`;
}

// Built from local parts, never `new Date(string)`: a datetime-local value has
// no zone, so parsing it as one would shift the moment by the offset.
export function fromDateTimeInputValue(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value ?? "").trim());
    if (!m) return null;
    const ts = new Date(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        0,
        0
    ).getTime();
    return Number.isFinite(ts) ? ts : null;
}

export function formatDate(ts) {
    if (!Number.isFinite(ts)) return "—";
    return new Date(ts).toLocaleDateString(undefined, {
        day: "2-digit",
        month: "2-digit",
        year: "numeric"
    });
}

// The wall clock, time only: what time it IS, as opposed to how long something
// has been running. The two are the same number on a running session and not the
// same answer — an hour of work from 23:50 to 00:50 is an hour either way, and
// only one of them is the time of day. `formatDateTime` is a date AND this.
export function formatTime(ts) {
    if (!Number.isFinite(ts)) return "—";
    return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

// For records that carry a real moment (a transaction, a debt payment) rather
// than a calendar day (a due date, a recurring anchor).
export function formatDateTime(ts) {
    if (!Number.isFinite(ts)) return "—";
    return `${formatDate(ts)} ${formatTime(ts)}`;
}

// A date to be read rather than decoded. The weekday is here because of the one
// case where a bare "28/09/2026" is accurate and still misleading: a session
// started yesterday evening and still running looks like it started today. The
// locale's own order and its own digits, like every other date in the app — the
// week is not a year, and this is not a database key.
export function formatDateLong(ts) {
    if (!Number.isFinite(ts)) return "—";
    return new Date(ts).toLocaleDateString(undefined, {
        weekday: "long",
        day: "numeric",
        month: "long"
    });
}

// "Today" / "Yesterday" / a formatted date. The two words come from the caller
// as a `labels` pair rather than being hardcoded here, so the same rule can be
// reused by the Arabic UI without this module reaching for a language.
// Anything older than yesterday gets a real date, formatted for the reader's
// locale — never a raw `YYYY-MM-DD` key.
export function dayLabel(ts, now = Date.now(), labels = {}) {
    if (!Number.isFinite(ts)) return "—";
    if (dayKey(ts) === dayKey(now)) return labels.today ?? "Today";
    if (dayKey(ts) === dayKey(now - DAY_MS)) return labels.yesterday ?? "Yesterday";
    return formatDate(ts);
}