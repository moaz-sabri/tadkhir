import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { store } from "../../app/store.js";
import { sessionPanel } from "../components/session-panel.js";
import { timeStage } from "../components/display.js";
import { page, pageHead, emptyState, action, card, sectionTitle } from "../components/ui.js";

// The page for the session in progress (/session), built as a STAGE rather than
// as another screen with a timer in it.
//
// The reason is a use, not an aesthetic: this page is opened to look at the
// time. Held at arm's length on a desk, glanced at across a room, or left running
// on a second screen for an hour. A timer competing with a page header, a
// checklist, a note box and a toolbar cannot be read at that distance — every one
// of those is a legitimate thing to want, and none of them is what you opened the
// page for.
//
// So the page is in two layers:
//
//   the stage    — the counter, the task name, the status, and the estimate as
//                  a ring. Nothing else, sized to fill whatever viewport there
//                  is. This is what is visible the instant the page opens.
//   the controls — the page head, the pause/finish buttons, the checklist and
//                  the note, in the normal page flow BELOW the stage, so the
//                  stage gets the whole screen and the work is still one scroll
//                  away rather than a mode to enter and leave.
//
// Both layers are always on the page. There is no "fullscreen mode" to toggle:
// a mode is a thing to discover, and a display on a wall has nobody to discover
// it with. The page simply leads with the time.
export const currentSession = {
    title: () => t("session.title"),

    mount(root) {
        const pageEl = h("div", { class: "page current-session-page" });
        let panelRef = null;

        this.stopPanel = () => {
            if (panelRef) { panelRef.stop(); panelRef = null; }
        };

        // No active session. It used to be a bare heading, a sentence and one
        // text link; it is now the same page head and the same empty state as
        // every other screen with nothing to show.
        const showEmpty = () => {
            this.stopPanel();
            pageEl.replaceChildren(
                pageHead({ title: t("session.title"), icon: "clock" }),
                emptyState(t("session.noActive"), {
                    icon: "clock",
                    action: action({ label: t("nav.home"), icon: "home", tone: "primary", href: "/" })
                })
            );
        };

        const render = () => {
            const active = store.getState().active;
            if (!active) return showEmpty();
            if (panelRef && panelRef.id === active.id) return;
            this.stopPanel();
            // No options: both layers of the panel are always on the page, so
            // there is no mode to switch on. What used to be passed here was a
            // `{ stage: true }` flag the panel never read, into a parameter that
            // was a callback — see the note on sessionPanel().
            panelRef = sessionPanel(active);
            pageEl.replaceChildren(panelRef.element);
        };

        root.append(pageEl);
        render();
        this.unsub = store.subscribe(s => s.active, render);
    },

    unmount() {
        this.unsub?.();
        this.unsub = null;
        this.stopPanel?.();
        this.stopPanel = null;
    }
};
