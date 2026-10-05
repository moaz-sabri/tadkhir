import { store } from "./store.js";

// The screen wake lock: a session the user is watching should not be measured
// against a screen that went to sleep halfway through it.
//
// WHAT WAS WRONG, AND IT IS WORTH WRITING DOWN
// The lock was requested from one place — a bus listener on "data-changed" — and
// that is the only moment it was ever asked for. Two failures came out of it:
//
//   * The browser RELEASES the lock the moment the page stops being visible, and
//     it must be requested again by the page on the way back. Nothing did that,
//     so the screen went dark the first time the tab lost focus and stayed dark
//     for the rest of the session — the exact case the feature exists for.
//   * Every data change asked for a NEW lock without releasing the one it had.
//     Each session transition therefore left a sentinel behind, and the only
//     thing that ever cleaned up was the last one.
//
// So the lifecycle is stated here once: one lock, taken when a session is
// running and the setting wants it, given back when it is not, taken again after
// the browser takes it away, and never two at once.
//
// A device that has no Wake Lock API is not an error and not a warning: there is
// nothing to hold, the session is still timed correctly (it is derived from the
// stored segments against the current clock, never from a running interval), and
// the only thing the user loses is the screen staying lit.

/**
 * One wake lock, built from injected parts.
 *
 * The parts are injected so the lifecycle can be tested without a browser — a
 * fake navigator, a fake window, and two functions that answer "is a session
 * running" and "does the user want this". The app's own instance is at the
 * bottom of this file, wired to the store.
 */
export function createWakeLock({
    nav = globalThis.navigator,
    win = globalThis,
    getSession = () => null,
    isEnabled = () => true
} = {}) {
    // The sentinel this module owns, and nothing else. `pending` exists so two
    // overlapping requests cannot both be in flight — a slow grant followed by a
    // fast one would otherwise leave the first sentinel orphaned.
    let held = null;
    let pending = null;
    let installed = false;

    function available() {
        return typeof nav?.wakeLock?.request === "function";
    }

    /** Is the user watching a session that is counting, and do they want it? */
    function wanted() {
        const session = getSession();
        return !!session && session.status === "running" && isEnabled();
    }

    async function request() {
        // Already ours. This is the line that was missing: a second request
        // without a release is a second lock nobody will ever give back.
        if (held) return true;
        if (pending) return pending;
        if (!available()) return false;
        pending = (async () => {
            try {
                const lock = await nav.wakeLock.request("screen");
                held = lock;
                // The platform takes the lock away on its own schedule — the tab
                // being hidden, the battery policy, the screen being turned off
                // by hand. Forgetting our reference here is what makes the
                // visibilitychange handler below able to take a new one.
                lock.addEventListener?.("release", () => {
                    if (held === lock) held = null;
                });
                return true;
            } catch {
                // Denied, or no document to lock. Same answer as unsupported.
                return false;
            } finally {
                pending = null;
            }
        })();
        return pending;
    }

    function release() {
        const lock = held;
        held = null;
        if (!lock) return;
        try {
            lock.release();
        } catch {
            // Already gone. Releasing a released lock is not an error worth
            // stopping for, and the reference is dropped either way.
        }
    }

    /** Bring the lock in line with what the session is doing right now. */
    function sync() {
        if (wanted()) return request();
        release();
        return Promise.resolve(false);
    }

    /**
     * Wire the one event that matters.
     *
     * Coming back to the tab is the moment the lock has to be taken AGAIN,
     * because the platform dropped it while we were away. Going away is where we
     * drop our reference, so a session that is still running when the user comes
     * back is holding a lock, not a stale sentinel.
     */
    function install() {
        if (installed) return;
        installed = true;
        win?.addEventListener?.("visibilitychange", () => {
            if (win.document?.hidden) release();
            else sync();
        });
        // Dismissal, bfcache eviction, a link opened with target=_blank. The
        // platform releases the lock in every one of these, but the reference is
        // ours to drop and a page restored from bfcache is a page that will ask
        // again the moment it is visible.
        win?.addEventListener?.("pagehide", release);
    }

    return {
        request,
        release,
        sync,
        install,
        available,
        // For tests, and for the Settings page's "your device cannot do this".
        isHeld: () => !!held
    };
}

/** The app's one lock, driven by the active session and the stored setting. */
export const wakeLock = createWakeLock({
    getSession: () => store.getState().active,
    // "Not false" for the same reason as haptics: a settings record from before
    // this existed has no key, and that device was already keeping the screen on.
    isEnabled: () => store.getState().settings?.keepAwake !== false
});
