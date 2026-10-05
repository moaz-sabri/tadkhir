import { store } from "../../app/store.js";
import { bus } from "../../app/bus.js";
import { sessionChip } from "./session-chip.js";

// The active-session bar, mounted once and kept for the life of the app.
//
// It is shown on every page EXCEPT the session page itself: that page is the
// session, drawn full-screen, so a second copy of the same information at the
// bottom of it is noise. Everywhere else the bar is how a running session stays
// visible and how it is paused without leaving whatever the user was doing.
//
// Its height is published as `--bar-h` on <html>, and it is the only thing that
// publishes it. Two other pieces of the shell are fixed to the bottom of the
// viewport — the add button and the toast — and neither knows this bar's height
// any other way, so all three add the same one number. Measuring rather than
// guessing: the bar's height depends on its content and on the viewport — a
// two-line task name on a phone is a taller bar than a one-line name on a
// desktop, and the docked layout is a different height from the floating one.
//
// WHAT IT PUBLISHES IS HOW MUCH OF THE BOTTOM EDGE IT TAKES, not how tall it is.
// Below 1024px the bar is docked across the bottom, so that is its height. From
// 1024px up it is a card floating beside the content, halfway up the screen — it
// is nowhere near the bottom edge, and a bar's worth of empty space reserved under
// every wide page for it is what put the add button 174px up a screen with nothing
// under it. So in that layout it publishes nothing, and the three things that
// clear it return to the corner.
const BAR_GAP = 10; // the bar's own gap from whatever it is docked above

// The width at which the bar stops being docked: the same value the stylesheet's
// chip layout switches on, and it has to be the same value, because the number
// this module publishes and the layout the stylesheet draws cannot both be right
// about a bar that is one thing on a phone and another on a desktop.
const FLOATING_FROM = "(min-width: 1024px)";

export const sessionStrip = {
    mount(root) {
        let bar = null;
        let onSessionPage = location.pathname === "/session";
        let observer = null;

        // 0 whenever the bar is not on screen — and 0 in the floating layout,
        // where it is on screen but not at the bottom. Everything that clears it —
        // the toast above all — returns to its normal position.
        const publishHeight = (element) => {
            if (!element || window.matchMedia(FLOATING_FROM).matches) {
                document.documentElement.style.removeProperty("--bar-h");
                return;
            }
            const h = Math.round(element.getBoundingClientRect().height) + BAR_GAP;
            document.documentElement.style.setProperty("--bar-h", `${h}px`);
        };

        const stopObserving = () => {
            observer?.disconnect();
            observer = null;
        };

        const hide = () => {
            if (bar) { bar.stop(); bar = null; }
            stopObserving();
            publishHeight(null);
            root.replaceChildren();
            root.hidden = true;
        };

        const render = () => {
            const active = store.getState().active;
            // Only running/paused sessions count as "active" for the reminder.
            const liveActive = active && ["running", "paused"].includes(active.status) ? active : null;
            if (onSessionPage || !liveActive) return hide();

            if (bar && bar.id === liveActive.id) {
                bar.update(liveActive);
                root.hidden = false;
                return;
            }
            if (bar) { bar.stop(); bar = null; }
            stopObserving();
            bar = sessionChip(liveActive);
            root.replaceChildren(bar.element);
            root.hidden = false;
            publishHeight(bar.element);
            // A ResizeObserver rather than a resize listener on the window: the
            // bar's height changes when the viewport changes, when the name wraps,
            // and when the session's own state changes which figures it shows.
            // Observing the element catches all three, and none of them.
            if (typeof ResizeObserver === "function") {
                observer = new ResizeObserver(() => publishHeight(bar?.element));
                observer.observe(bar.element);
            }
        };

        const unsubStore = store.subscribe(s => s.active, render);
        const offRoute = bus.on("route", path => {
            onSessionPage = path === "/session";
            render();
        });
        // Crossing the breakpoint with a session running changes what the bar takes
        // from the bottom edge, and nothing about that change is guaranteed to
        // resize the bar — the two layouts can measure the same. So the query is
        // watched as well, and the number is published again either way.
        const floating = window.matchMedia(FLOATING_FROM);
        const onLayoutChange = () => publishHeight(bar?.element);
        floating.addEventListener("change", onLayoutChange);
        render();
        return () => {
            unsubStore();
            offRoute();
            floating.removeEventListener("change", onLayoutChange);
            hide();
        };
    }
};
