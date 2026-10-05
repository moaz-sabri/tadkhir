import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { haptics } from "../../app/haptics.js";

// One toast on screen, replaced by the next. The timer is tracked rather than
// fired blind: a `setTimeout` per call meant the first toast's timer wiped the
// second toast off the screen early whenever two arrived inside 3.2 seconds —
// which happens on every form that reports a validation failure and then a
// success, and on every save that also triggers a backup reminder.
const LIFETIME_MS = 3200;
let timer = null;

export const toast = {
    show(key, params = {}) {
        const root = document.querySelector("#toast-root");
        if (!root) return;
        // A failure gets a pulse, and it gets it HERE rather than at each of the
        // ~thirty call sites that report one: every failure in this app already
        // arrives as a toast, so this is the one place that can be sure it is a
        // failure and not a confirmation. One pulse per toast, because a toast
        // replaces the one before it — a form that fails and then succeeds gives
        // one buzz and one quiet line, not a buzz per line.
        //
        // Successes are silent on purpose. A confirmation the user just asked for
        // is already visible, and a phone that buzzes at every save is a phone
        // whose buzzes stop being read.
        if (typeof key === "string" && key.startsWith("error.")) haptics.do("error");
        clearTimeout(timer);
        root.replaceChildren(h("div", { class: "toast" }, t(key, params)));
        timer = setTimeout(() => {
            timer = null;
            root.replaceChildren();
        }, LIFETIME_MS);
    }
};
