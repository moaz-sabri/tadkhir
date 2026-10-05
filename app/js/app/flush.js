// Save-anything-pending, for the moment the app is about to stop being on screen.
//
// WHY THIS EXISTS
// Every autosaving field in the app debounces, because saving on every
// keystroke is absurd, and every one of them also saves on blur. Neither covers
// the case that loses the most and complains the least: the user types a line,
// then switches apps. Blur does not fire reliably there, the 500 ms timer is
// still counting, and a phone will then freeze or discard the tab — taking the
// unsaved words with it. The user comes back and the line they just wrote is
// shorter than they remember writing, and nothing anywhere said why.
//
// So there is one place that knows when the app is going away, and every pending
// save registers here. Two triggers, and both are needed:
//
//   visibilitychange → hidden  the reliable one. It fires on tab switch, on
//                                   locking the screen, and on switching apps,
//                                   and an IndexedDB write started from it
//                                   usually completes — the page is still alive.
//   pagehide                 bfcache and page dismissal. Later and less certain,
//                                   because the page may be frozen the moment it
//                                   returns, so anything still queued is best
//                                   effort.
//
// WHAT IT IS NOT
// It is not a durable draft store. It cannot be: an uncommitted write has not
// been validated, and a restore-from-draft path would have to decide which
// half-written record wins against the one on disk. This closes the 500 ms
// window, which is the whole of the loss, and it does it with the save the
// screen already had.

const pending = new Set();

/**
 * Register something to run when the app is hidden. Returns the unsubscribe.
 *
 * A Set, not a list, so a screen that mounts and unmounts repeatedly (the same
 * page, navigated back to) cannot pile up callbacks that outlive their DOM.
 */
export function onFlush(fn) {
    pending.add(fn);
    return () => pending.delete(fn);
}

/**
 * Run everything registered, now. Safe to call with nothing registered.
 *
 * One failure must not stop the rest: these are independent writes for
 * independent records, and the second field on a page matters exactly as much
 * as the first. A thrown error here is swallowed deliberately — this runs from
 * an event handler on the way out of the page, where there is nowhere to report
 * it to, and one screen's failure must not become another's loss.
 */
export function flushNow() {
    for (const fn of [...pending]) {
        try {
            fn();
        } catch {
            // Intentionally ignored; see above.
        }
    }
}

/**
 * Wire the two triggers. Called once, from boot.
 *
 * The `visibilitychange` handler checks for `hidden` rather than firing on both
 * edges: coming back to the tab is not a moment that needs saving, and flushing
 * on the way in would fire writes for fields the user has not touched.
 */
export function installFlushTriggers(win = globalThis) {
    if (!win || typeof win.addEventListener !== "function") return;
    win.addEventListener("visibilitychange", () => {
        if (win.document?.hidden === true) flushNow();
    });
    win.addEventListener("pagehide", flushNow);
}
