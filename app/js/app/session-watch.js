import { store } from "./store.js";
import { elapsedMs, isOver } from "../domain/session-engine.js";
import { haptics } from "./haptics.js";
import { notifications } from "./notifications.js";
import { beep } from "../ui/sound.js";
import { t } from "../i18n/i18n.js";
import { formatClock } from "../domain/time.js";

// The one place that notices a session has reached its estimate.
//
// WHY THIS IS NOT IN THE PANEL OR IN THE CHIP
// It used to be in both. Each kept its own `vibrated` flag, each called
// `navigator.vibrate(200)` — and only the chip also rang the bell, so the alert
// depended on which screen you happened to be standing on. Worse, the alert only
// existed while one of those two components was mounted: the estimate is reached
// on whatever screen the user has wandered off to, and on a page with no session
// UI there was nothing at all to say so.
//
// A third copy would have been worse than either. The rule here is that crossing
// the estimate is a fact about the SESSION, so the module that owns the answer
// owns the signal — and the two views stop knowing it exists. They keep drawing
// "ESTIMATED TIME REACHED" on their status lines, which they always did.
//
// ONCE PER CROSSING
// Elapsed time only goes one way, so a latch is enough: the check runs once a
// second while the app is in front of the user and roughly once a minute while it
// is not, and after the alert has been delivered the latch refuses to deliver it
// again. That is what makes the background case safe — a throttled tab that
// catches up, then becomes visible, then catches up again, produces one alert
// and not three.
//
// THE TICK IS ABOUT THE ALERT, NOT THE CLOCK
// The countdown does not come from here. The panel and the chip both derive the
// elapsed time from the stored segments against `Date.now()`, so the figure is
// right whether JavaScript ran every second for an hour or was frozen for all of
// it. This timer exists to notice an EDGE, and a coarse one is enough.

const VISIBLE_MS = 1000;
// A hidden tab is throttled to about one wake-up a minute by every engine that
// runs one at all, so asking more often than this spends battery to be throttled
// to the same answer. The catch-up on the way back in is what makes the delay
// bounded.
const HIDDEN_MS = 30000;

/**
 * A watcher built from injected parts, so the latch and the both-edges-of-
 * visibility behaviour can be tested with a fake session and a fake clock and
 * without a browser.
 */
export function createSessionWatch({
    getSession = () => null,
    isHidden = () => false,
    isVisible = () => true,
    canNotify = () => false,
    notify = async () => false,
    buzz = () => false,
    ring = () => {},
    buildMessage = () => ({ title: "", body: "" }),
    win = globalThis,
    setTimer = (fn, ms) => setInterval(fn, ms),
    stopTimer = id => clearInterval(id),
    visibleMs = VISIBLE_MS,
    hiddenMs = HIDDEN_MS
} = {}) {
    let timer = null;
    let started = false;
    // The latch, and the session it belongs to. Keyed by id so a finished session
    // followed by a new one cannot inherit "already alerted" from it.
    let sessionId = null;
    let alerted = false;

    function check() {
        const session = getSession();

        // Nothing running, or nothing counting. The latch is cleared rather than
        // kept: a paused session that is resumed is counting again, and a session
        // that is already past its estimate on the way in still has to say so.
        if (!session || session.status !== "running") {
            sessionId = null;
            alerted = false;
            return;
        }
        if (session.id !== sessionId) {
            sessionId = session.id;
            alerted = false;
        }
        if (!isOver(session, Date.now())) {
            alerted = false;
            return;
        }
        if (alerted) return;
        alerted = true;

        buzz("over");
        ring();
        // Only when the platform will actually show it. `notify` re-checks the
        // permission and the setting itself, so this is a cheap short-circuit
        // rather than a second source of truth.
        if (canNotify()) notify(buildMessage(session, elapsedMs(session, Date.now())));
    }

    // One second in front of the user, one minute behind their back. Both are
    // edges: neither interval is what makes the clock tick.
    function arm() {
        stopTimer(timer);
        timer = started ? setTimer(check, isHidden() ? hiddenMs : visibleMs) : null;
    }

    function onVisibility() {
        arm();
        // The catch-up. If the estimate was passed while this tab was asleep, no
        // timer in any engine can have noticed, and this is the first moment at
        // which anyone can. The latch means it is delivered once, here.
        if (isVisible()) check();
    }

    return {
        check,
        arm,
        start() {
            if (started) return;
            started = true;
            win?.addEventListener?.("visibilitychange", onVisibility);
            arm();
            check();
        },
        stop() {
            started = false;
            stopTimer(timer);
            timer = null;
            win?.removeEventListener?.("visibilitychange", onVisibility);
            sessionId = null;
            alerted = false;
        }
    };
}

/** The app's watcher: the real store, the real alerts, the real clock. */
export const sessionWatch = createSessionWatch({
    getSession: () => store.getState().active,
    isHidden: () => globalThis.document?.hidden === true,
    isVisible: () => globalThis.document?.hidden !== true,
    canNotify: () => notifications.granted(),
    notify: message => notifications.send(message),
    buzz: kind => haptics.do(kind),
    ring: () => beep(),
    buildMessage: (session, ms) => ({
        // The title says what happened, because it is the line a phone shows
        // large and the rest of it is a line the user may not read.
        title: t("session.alertEstimateTitle"),
        // And the body says which session, with the time it reached it — the two
        // facts that make the alert worth acting on rather than dismissing.
        body: `${session.taskTitle || t("session.free")} · ${formatClock(ms)}`,
        // Tapping the alert opens the session, not the home screen: the one
        // useful destination at that moment. Read by sw.js's notificationclick.
        data: { url: "/session" }
    })
});
