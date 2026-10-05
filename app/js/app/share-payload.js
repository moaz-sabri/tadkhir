// The share payload, parked between the OS handing it over and the user picking
// what to do with it.
//
// The manifest's share target POSTs whatever was shared to /api/share/intake,
// which parks it and redirects to /share?t=<token>. That request is consumed in
// main.js BEFORE the router starts, for the same reason it always has to be: the
// router matches location.pathname only and then rewrites the URL, so a page
// mounted on the share path would navigate the router from inside its own mount
// and leave the query string in the address bar for the next reload to replay.
//
// A `t` parameter is the second half of that: a shared FILE cannot travel in a
// URL, so the token stands in for it until share-intake.js has fetched the bytes
// back. The token is parked like the rest of the payload, which is what lets a
// reload of the chooser still find the shared photograph — the server holds it
// for ten minutes, and the parked token is how the app asks for it again.
//
// Nothing is written to the database here. What a share becomes — an income
// record, an expense, a running session, a follow-up item — is the user's
// decision, and the chooser screen is where they make it. This module only
// carries the raw parameters across; each destination parses them with the
// parser it already owns (fromSharePayload for Later, the prefill helper below
// for the money and session forms), so there is one rule per destination rather
// than a second set of rules in the middle.

const KEY = "share-pending";

// Long enough to survive a reload, a rotation and a trip to the share sheet
// again; short enough that a share left open in a background tab all afternoon
// is not offered as if it were fresh. Past this, the payload is dropped.
const TTL_MS = 15 * 60 * 1000;

export function readShareParams(search = location.search) {
    const params = new URLSearchParams(search);
    return {
        url: (params.get("url") || "").trim(),
        text: (params.get("text") || "").trim(),
        title: (params.get("title") || "").trim(),
        // The intake token, when the share came through the server. An empty
        // string rather than null, like every other field here: a caller reads
        // one shape, and `""` is falsy in every way `null` is.
        token: (params.get("t") || "").trim()
    };
}

// A token is 32 lowercase hex characters or it is not one. Checked here rather
// than only where it is used, so nothing ever puts an arbitrary query parameter
// into a request URL.
const TOKEN = /^[a-f0-9]{32}$/;

/** True when the share sheet handed over something worth offering. */
export function hasContent(payload) {
    return !!payload && !!(payload.url || payload.text || payload.title || hasToken(payload));
}

/** True when the share carries a parked file the app still has to fetch. */
export function hasToken(payload) {
    return typeof payload?.token === "string" && TOKEN.test(payload.token);
}

// The one line a form should prefill its title with.
//
// Preference order, because the three fields overlap: the text is what the user
// actually highlighted and therefore what they meant, the title is the page's
// name, and the url is the fallback when a share carried nothing else. This is
// deliberately not the same rule as Later's — a follow-up item keeps the link
// and the note separately, where a money record's title is one line and the
// most meaningful line wins.
const URL_ONLY = /^\s*(?:https?:\/\/|www\.)\S+\s*$/i;

export function sharePrefill(payload, max = 120) {
    if (!payload) return "";
    const text = (payload.text || "").trim();
    const title = (payload.title || "").trim();
    const url = (payload.url || "").trim();

    // A share sheet that sends the link as the text and repeats the page title
    // is very common: prefer the title over text that is only a url.
    if (title && !URL_ONLY.test(text)) return title.slice(0, max);
    if (text && !URL_ONLY.test(text)) return text.slice(0, max);
    if (title) return title.slice(0, max);
    return url.slice(0, max);
}

// Parked in sessionStorage rather than in a module variable, because the gap
// between the share and the choice can include a reload — and a reload has to
// find the payload still there, or the share is lost.
//
// One key, not a queue: a second share overwrites the first. That is the honest
// behaviour — if two shares arrive before either is dealt with, the older one was
// never looked at, and silently saving both would be worse.
export function stashShare(payload) {
    if (!hasContent(payload)) return null;
    try {
        sessionStorage.setItem(KEY, JSON.stringify({ ...payload, at: Date.now() }));
    } catch {
        // Private mode or a full quota. The chooser still works from the values
        // it already holds; the payload just will not survive a reload.
    }
    return payload;
}

function read() {
    let raw;
    try {
        raw = sessionStorage.getItem(KEY);
    } catch {
        return null;
    }
    if (!raw) return null;
    let parsed = null;
    try {
        parsed = JSON.parse(raw);
    } catch {
        parsed = null;
    }
    // Malformed, or too old to still be what the user is looking at: gone.
    if (!parsed || typeof parsed !== "object" || Date.now() - (parsed.at ?? 0) > TTL_MS) {
        drop();
        return null;
    }
    return parsed;
}

function drop() {
    try {
        sessionStorage.removeItem(KEY);
    } catch {
        /* nothing to do: the key is already unreachable */
    }
}

// Read without consuming, for the chooser's preview.
export function peekShare() {
    return read();
}

// Read and clear in one step, for the destination. The payload is consumed by
// the form it prefills, so leaving it behind would let a later reload replay a
// share that was already dealt with — the same double-save the early rewrite
// exists to prevent.
export function takeShare() {
    const payload = read();
    drop();
    return payload;
}
