import { h, flash } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { uiIcon } from "../icons.js";
import { formatClock } from "../../domain/time.js";
import { hasEstimate } from "../../domain/session-engine.js";
import { MAX_DURATION_MS } from "../../domain/validation.js";
import { store } from "../../app/store.js";
import { router } from "../../app/router.js";
import { haptics } from "../../app/haptics.js";
import { sessionService } from "../../services/session-service.js";
import { toast } from "./toast.js";
import { action } from "./ui.js";

// The active-session bar: the one thing that follows the user across every
// screen while a session is live.
//
// It answers three questions without being read, which is the only way a
// floating element earns the space it takes:
//
//   is a session running   — the bright card itself, the pulse, the counter
//   what is it              — the task name, on the card
//   how do I stop it       — ONE button, on the card, that is the pause or the
//                            resume depending on the state it is reporting
//
// Tapping anywhere else on the card opens the full session screen, so the way
// from "I noticed the timer" to "I want the timer" is the card itself and
// nothing has to be found first.
//
// The two controls are SIBLINGS and not nested, and that is the whole markup
// decision. A button inside an anchor is invalid HTML; a browser that repairs it
// makes one tap mean two things, and on a phone held in a hand that is the tap
// nobody is looking at. So the card is a plain element holding a link and a
// button, and the card's hover/press feedback belongs to the card — scaling only
// the link would leave the button behind a shape that moved.
//
// The session's own logic is untouched: pause and resume are the two service
// calls the session page already makes, and the store refresh they trigger is
// what redraws this bar, exactly as it redraws every other view of the session.
export function sessionChip(session) {
    let timer = null;
    let titleWritten = false;
    let lastStatus = session.status;
    // A tap is a request, and a second tap while the first is still being written
    // is a second request for the same change. The control is disabled for the
    // duration and this refuses the re-entry behind it, because a pause that
    // lands after a resume leaves the bar reporting a state the session is not in
    // until the store catches up.
    let busy = false;

    const dot = h("span", { class: "live-dot", hidden: true });
    const label = h("span", { class: "chip-label own-text" }, taskTitle(session));
    const timeEl = h("span", { class: "chip-time number", role: "timer" });
    const statusEl = h("span", { class: "chip-status" });
    const pctEl = h("span", { class: "chip-pct number", hidden: true });

    // The one control, rebuilt in place rather than re-created. A fresh node per
    // state change would drop keyboard focus the moment a keyboard user pressed
    // the button, which is the one person guaranteed to notice.
    const toggleText = h("span", { class: "chip-toggle-text" });
    const toggleBtn = action({
        label: t("session.pause"),
        icon: "pause",
        className: "chip-toggle",
        onClick: () => toggle()
    });

    // Built before the first render, not in the returned object, because
    // render() pulses this element and there is nothing to pulse until it exists.
    const element = h("div", {
        class: "session-chip",
        // The card is a labelled group rather than a landmark: it is a floating
        // reminder, and giving it a region role would put it in the screen
        // reader's landmark list next to the navigation, which it is not.
        role: "group",
        "aria-label": t("session.title")
    },
        h("a", {
            class: "chip-open",
            href: "/session",
            "data-link": true,
            "aria-label": t("session.open")
        },
            h("span", { class: "chip-top" }, dot, label),
            timeEl,
            h("span", { class: "chip-meta" }, statusEl, pctEl)
        ),
        h("div", { class: "chip-actions" }, toggleBtn)
    );

    function taskTitle(s) {
        return s.taskTitle || t("session.free");
    }

    // Ascending elapsed time, capped at the 72 h ceiling.
    function elapsedOf(s) {
        const now = Date.now();
        const raw = s.segments.reduce((a, x) => a + Math.max(0, (x.end ?? now) - x.start), 0);
        return Math.min(MAX_DURATION_MS, raw);
    }

    // Pull the live active session from the store on every render so the
    // timer always reflects the persisted state.
    function live() {
        const active = store.getState().active;
        return active && active.id === session.id ? active : session;
    }

    function setToggle(status) {
        const running = status === "running";
        const word = running ? t("session.pause") : t("session.resume");
        toggleBtn.replaceChildren(
            uiIcon(running ? "pause" : "play", { className: "icon btn-icon" }),
            toggleText
        );
        toggleText.textContent = word;
        // The visible word is dropped on a narrow screen to make room for the
        // counter, so the name has to live in the attributes as well — which is
        // where a screen reader looks for it either way.
        toggleBtn.setAttribute("aria-label", word);
        toggleBtn.title = word;
    }

    async function toggle() {
        if (busy) return;
        const cur = live();
        if (cur.status !== "running" && cur.status !== "paused") return;
        busy = true;
        toggleBtn.disabled = true;
        try {
            if (cur.status === "running") {
                haptics.do("pause");
                await sessionService.pause();
            } else {
                haptics.do("resume");
                await sessionService.resume();
            }
            // Nothing is applied by hand here. The service call ends in the same
            // store notification every other pause does, and the subscription
            // below redraws from it — so this bar and the session page can never
            // disagree about the state, whichever one changed it.
        } catch (e) {
            toast.show(`error.${e?.code || "unexpected"}`);
        } finally {
            busy = false;
            toggleBtn.disabled = false;
        }
    }

    // While this card is visible, mirror the countdown in the browser tab title.
    function writeTitle(text) {
        document.title = `${text} · ${taskTitle(session)}`;
        titleWritten = true;
    }

    function render() {
        const cur = live();
        const elapsed = elapsedOf(cur);
        // "Has an estimate" is the engine's own answer, the same rule the panel
        // and the alert use. A free session is never over anything.
        const estimateReached = hasEstimate(cur) && elapsed >= cur.estimatedMs;

        const text = formatClock(elapsed);
        timeEl.textContent = text;
        label.textContent = taskTitle(cur);
        statusEl.textContent = estimateReached
            ? `${t(`session.${cur.status}`)} · ${t("session.estimateReached")}`
            : t(`session.${cur.status}`);
        writeTitle(text);

        if (cur.taskId && cur.estimatedMs > 0) {
            const pct = Math.min(100, Math.floor((elapsed / cur.estimatedMs) * 100));
            pctEl.textContent = `${pct}%`;
            pctEl.hidden = false;
        } else {
            pctEl.hidden = true;
        }

        // A state change, from anywhere: a tap on this card, a tap on the session
        // page, a change that arrived through sync, a second tab finishing its
        // own session.
        if (cur.status !== lastStatus) {
            lastStatus = cur.status;
            setToggle(cur.status);
            flash(element, cur.status);
        }

        dot.hidden = cur.status !== "running";
    }

    setToggle(session.status);
    render();
    // A hidden tab does not need the bar ticking once a second, and the render
    // writes document.title every time — which both costs battery in the
    // background and fights the router for the tab title. The clock is derived
    // from the stored segments, so the value is exact again the moment the tab
    // is looked at; nothing is lost by not counting in between. The estimate
    // alert is not held back here either, and deliberately so: it belongs to
    // app/session-watch.js, which keeps its own coarse timer for exactly the case
    // where this bar's interval is switched off.
    timer = setInterval(() => { if (!document.hidden) render(); }, 1000);

    return {
        id: session.id,
        element,
        update(next) {
            session = next;
            render();
        },
        stop() {
            clearInterval(timer);
            if (titleWritten) {
                titleWritten = false;
                document.title = router.pageTitle();
            }
        }
    };
}
