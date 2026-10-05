import { store } from "./store.js";
import { haptics } from "./haptics.js";

// Browser notifications, with every way this can fail contained in one file.
//
// WHAT THIS IS FOR
// The one event worth interrupting for is the session reaching its estimate. It
// is a timer the user is not looking at — the phone is in a pocket, or the tab
// is behind another one — and the in-app beep and vibration cannot be heard from
// there. A system notification is the only channel a PWA has that reaches a
// screen nobody is looking at.
//
// WHY IT IS NOT A PUSH
// There is no push server here, and adding one would be the wrong trade for an
// app whose whole premise is that its data never leaves the device unencrypted.
// So the alert is REACTIVE, not scheduled: it is produced the moment the app
// notices the estimate has been passed. While the app is in the foreground that
// is within a second. While it is in the background, a browser may or may not
// run the check at all — a background tab is throttled to roughly once a minute,
// and iOS freezes it outright — so on the way back in the check runs once more
// and the alert is delivered then, late and exactly once. Both are honest
// answers for a platform with no wake-up server, and both are worse than a real
// native app can be. The timer itself does not depend on any of this: it is
// derived from the stored segments against the current clock, so it is correct
// whether the app was awake, throttled or frozen the whole time.
//
// THE PERMISSION IS ASKED FOR LATE, OR NEVER
// A permission prompt on first launch is the single most effective way to train
// someone to dismiss prompts. So it is not asked there: `sessionService.start()`
// calls `ask()` as its first statement, in the same task as the tap that started
// the session, which is the first moment notifications are relevant to anybody.
// A browser whose answer is already "granted" or "denied" is not asked again,
// ever, so this is one prompt per browser per site and not one per session.
const TAG = "task-timer-session";

function api(win) {
    return win?.Notification ?? null;
}

export const notifications = {
    supported(win = globalThis) {
        const N = api(win);
        return !!N && typeof N.requestPermission === "function";
    },

    /** "granted" | "denied" | "default" | "unsupported" */
    permission(win = globalThis) {
        const N = api(win);
        if (!N) return "unsupported";
        return String(N.permission ?? "default");
    },

    // The user's INTENT, which is not the same as the browser's answer and does
    // not travel with a device: the permission itself belongs to this browser
    // for this origin, and the setting is what they asked for in the app.
    enabled() {
        return store.getState().settings?.notify !== false;
    },

    /** The only question send() needs answered: may a notification be shown? */
    granted(win = globalThis) {
        return this.enabled() && this.permission(win) === "granted";
    },

    /**
     * Ask, once, and only if there is anything to ask.
     *
     * Must be called from the task of a user gesture: that is why the caller puts
     * it first. Resolves to the resulting permission, never rejects — a prompt
     * that throws is a prompt that was refused.
     */
    async ask(win = globalThis) {
        const N = api(win);
        if (!N || typeof N.requestPermission !== "function") return "unsupported";
        // Already answered. Re-prompting a site the user has blocked is not
        // possible, and re-asking one that allowed is at best noise.
        if (N.permission !== "default") return String(N.permission);
        try {
            return String(await N.requestPermission());
        } catch {
            return "denied";
        }
    },

    /**
     * Show one notification, through the service worker when there is one.
     *
     * The worker is preferred because it is the only route whose click can be
     * handled: `notificationclick` there is what turns tapping the alert into
     * opening this app on the running session. A bare `new Notification()` still
     * works, and is what a browser without an active registration gets.
     *
     * Resolves to whether anything was shown. Never rejects, because every caller
     * of this is a timer tick or an event handler that has nothing to do with a
     * notification that did not arrive.
     */
    async send({ title, body = "", tag = TAG, data = null }, win = globalThis) {
        if (!this.granted(win)) return false;
        const options = {
            body,
            tag,
            data,
            icon: "/icons/icon-192.png",
            // A pulse from the notification itself. `navigator.vibrate` does
            // nothing in a background tab, and on the platform that honours this
            // key it is the alert the user feels rather than one this page had to
            // fire in time. Carried only when haptics are wanted at all.
            ...(haptics.enabled() ? { vibrate: [60, 80, 60] } : {}),
            // Repeats REPLACE rather than stack. The estimate is reached once per
            // session, but a tab that was throttled and then caught up could
            // produce a second, and two identical alerts for one event is the
            // kind of noise that makes people turn notifications off.
            renotify: false
        };
        try {
            const registration = await win.navigator?.serviceWorker?.getRegistration?.();
            if (registration?.showNotification) {
                await registration.showNotification(title, options);
                return true;
            }
            const N = api(win);
            if (!N) return false;
            // No `const` binding on purpose: the constructor IS the delivery,
            // and the Notification object is not needed again.
            new N(title, options);
            return true;
        } catch {
            return false;
        }
    }
};
