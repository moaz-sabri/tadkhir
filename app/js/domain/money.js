// Money is always an integer number of MINOR UNITS (cents): 12.99 EUR is
// stored as 1299. No floating point value ever reaches storage, sync or a
// computed total. This mirrors how durations are stored as whole milliseconds.

export const MINOR_UNITS = 100;
export const DEFAULT_CURRENCY = "EUR";

const formatterCache = new Map();

// `numberingSystem: "latn"` for the same reason as domain/time.js: an amount
// must stay readable and copy-pasteable in the Arabic layout, so the digits
// never depend on the device locale.
function formatter(currency) {
    let f = formatterCache.get(currency);
    if (!f) {
        try {
            f = new Intl.NumberFormat(undefined, { style: "currency", currency, numberingSystem: "latn" });
        } catch {
            f = null; // unknown currency code -> plain number below
        }
        formatterCache.set(currency, f);
    }
    return f;
}

// "12.99" | "12,99" | 12.99 -> 1299. Returns null when the input is not a
// non-negative amount with at most two decimals.
export function toMinorUnits(value) {
    if (typeof value === "number") {
        if (!Number.isFinite(value) || value < 0) return null;
        return Math.round(value * MINOR_UNITS);
    }
    const raw = String(value ?? "").trim().replace(",", ".");
    if (!/^\d+(\.\d{0,2})?$/.test(raw)) return null;
    const [whole, frac = ""] = raw.split(".");
    const minor = Number(whole) * MINOR_UNITS + Number((frac + "00").slice(0, 2));
    return Number.isSafeInteger(minor) ? minor : null;
}

// 1299 -> "12.99", for prefilling an amount input.
export function toAmountInputValue(minor) {
    if (!Number.isInteger(minor)) return "";
    return (minor / MINOR_UNITS).toFixed(2);
}

// A currency reaches a formatter from a record, and a record that does not
// exist cannot name one: the month with no transactions carries
// `currency: null`, an untouched debt carries `undefined`. A parameter default
// only covers `undefined`, so `formatMoney(0, null)` used to print "0.00
// null" on the dashboard - the number was right and the currency next to it
// was a hole in the data leaking onto the screen. Storage guarantees a
// three-letter uppercase code (validateFinanceCurrency), so anything else means
// "nothing told us" and the app-wide single currency stands in.
function normalizeCurrency(currency) {
    return typeof currency === "string" && /^[A-Z]{3}$/.test(currency) ? currency : DEFAULT_CURRENCY;
}

export function formatMoney(minor, currency = DEFAULT_CURRENCY) {
    const safe = Number.isInteger(minor) ? minor : 0;
    const value = Math.abs(safe) / MINOR_UNITS;
    const code = normalizeCurrency(currency);
    const f = formatter(code);
    return f ? f.format(value) : `${value.toFixed(2)} ${code}`;
}

// A figure that can be NEGATIVE, and says so. `formatMoney` prints the absolute
// value on purpose — the label beside an amount carries its direction — which is
// right for "42.50 € spent" and wrong for a NET, where the sign IS the answer.
//
// Three callers used formatMoney for a net, and every one of them printed a loss
// as a gain: a month of 42.50 € spent and nothing earned reads "Net 42.50 €" in
// the same typeface and the same colour as a month of profit. This function
// existed the whole time and had no caller.
//
// The sign is a real minus (U+2212), not a hyphen. It is not pasted onto a
// locale's own numerals, which is a limitation and not a virtue: the platform's
// signDisplay would be the right answer, but it cannot be threaded through the
// cached formatter formatMoney shares with every other amount in the app without
// changing all of them, and a net that prints its own sign in front of a
// correctly-formatted amount is the smaller of the two problems.
export function formatSignedMoney(minor, currency = DEFAULT_CURRENCY) {
    const safe = Number.isInteger(minor) ? minor : 0;
    if (safe === 0) return formatMoney(0, currency);
    return (safe > 0 ? "+" : "−") + formatMoney(Math.abs(safe), currency);
}
