import { store } from "./store.js";

// Haptic feedback: the short pulse a phone gives you when something happened.
//
// WHY THIS IS A MODULE AND NOT A LINE AT EACH CALL SITE
// `navigator.vibrate` was called from two places, with two different meanings
// for the same 200ms, and neither checked the user's preference. Four things
// have to be true before a device is allowed to buzz, and a call site that only
// remembers one of them is how a timer ends up buzzing at someone in a meeting:
//
//   1. the platform has the API at all — iOS Safari does not, and neither does
//      any desktop browser;
//   2. the user has not turned it off in Settings;
//   3. the kind being asked for is one this file has a pattern for — a typo must
//      be silence, not a default 200ms;
//   4. it is not the same pulse twice inside a few tens of milliseconds, which
//      is what a single user action that two callers both report looks like.
//
// The table is also the reason the app does not buzz on every tap. There is no
// "button" entry. A pulse is a statement about something that happened — a
// session started, a choice was registered, an operation failed — and adding a
// generic one is exactly how a web page starts to feel like a toy.
//
// The preference is read from the store on every call rather than cached in a
// module variable, so flipping the setting in Settings takes effect on the very
// next press with nothing to keep in step.
const PATTERNS = Object.freeze({
    // A choice was registered: a dialog answer, a toggle, a checkbox.
    ack: 8,
    // A session is now counting.
    start: 14,
    // It stopped counting, and it started again — deliberately two different
    // shapes, because on a timer those are two different things that happened.
    pause: [18, 50, 18],
    resume: [10, 50, 10],
    // It ended, and it ended well: the long-short-long of something finished.
    finish: [20, 60, 40, 60, 20],
    // Something destructive or worth noticing happened.
    warn: [30, 60, 30],
    // An operation failed.
    error: [40, 60, 40],
    // The estimate was reached, and the user did not ask for it — so it is the
    // most insistent pattern here, and it fires once per crossing.
    over: [60, 80, 60, 80, 60]
});

// Two reports of the same pulse this close together are one event. A tap on
// "Finish" confirms, writes, navigates and reports; without this the phone would
// answer with three identical pulses where one is meant.
const DEDUPE_MS = 90;

const lastAt = new Map();

// Read as "not false" rather than "=== true": a settings record written by an
// older release, or pulled from a device that has never heard of haptics, has no
// `haptics` key at all — and that device buzzed before, so it keeps buzzing.
function allowed() {
    return store.getState().settings?.haptics !== false;
}

export const haptics = {
    // Exposed so the Settings page can say "this device cannot vibrate" instead
    // of offering a switch that would do nothing.
    patterns: PATTERNS,

    supported(nav = globalThis.navigator) {
        return !!nav && typeof nav.vibrate === "function";
    },

    enabled() {
        return allowed();
    },

    /**
     * The whole point of this module: a device with no vibration, a browser that
     * refuses, a user who turned it off, and a misspelled kind all land on the
     * same silent path, and no call site has to know which one it hit.
     *
     * Returns whether the device was actually asked, which is only useful to a
     * test — callers are not branching on it.
     *
     * ONE CONSOLE LINE IS EXPECTED AND IS NOT A BUG: Chrome refuses a
     * `navigator.vibrate` call made before the user has touched the frame at all,
     * logs "Blocked call to navigator.vibrate…" as an error, and returns false
     * without throwing. That is a gesture policy, not a failure, and it is
     * reachable by design — the estimate alert fires at start-up when a session
     * is already past its estimate. The call is a no-op and the alert goes out
     * through the sound and the notification regardless.
     */
    do(kind, { nav = globalThis.navigator } = {}) {
        try {
            if (!allowed()) return false;
            if (!this.supported(nav)) return false;
            const pattern = PATTERNS[kind];
            if (pattern == null) return false;

            const now = Date.now();
            if (now - (lastAt.get(kind) ?? -Infinity) < DEDUPE_MS) return false;
            lastAt.set(kind, now);

            nav.vibrate(pattern);
            return true;
        } catch {
            // A device that exposes vibrate() and then throws is still a device
            // that cannot vibrate. Feedback is never allowed to be the thing
            // that breaks a timer.
            return false;
        }
    },

    // Test seam: the dedupe window is time, and a test that waits 90ms to prove
    // a suppression is a slow test. This says "the next call counts as new".
    reset() {
        lastAt.clear();
    }
};
