import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { bus } from "../../app/bus.js";
import { haptics } from "../../app/haptics.js";
import { action, toolbar, emptyState } from "./ui.js";
import { field, caption, fieldError } from "./fields.js";

// Dismissal is a distinct value rather than null. A form resolves with whatever
// its submit handler passes to `close`, and a caller may legitimately pass null,
// so "the user pressed Cancel" has to stay tellable apart from it. Callers
// compare against dialog.CANCELLED; it is a symbol, so it can never collide
// with a real answer.
const CANCELLED = Symbol("dialog.cancelled");

// One dialog at a time, and one lifecycle for every shape.
//
// This is the ONLY modal in the app. Two others used to build their own
// `.dialog-backdrop` / `.dialog` by hand — the category form and the person
// picker — and paid for it: neither listened for a navigation, so both stayed on
// screen over the page that replaced them; neither guarded against a second
// dialog stacking on top; and both resolved with a bare `null` instead of the
// sentinel, which forced every caller to add an adapter. A new modal is
// `dialog.form`, never a hand-rolled backdrop.
//
// The open dialog is tracked in a module variable rather than only by its DOM
// node, because the two things that used to go wrong both need it: a second
// dialog opening while the first is up, and a navigation landing while one is
// up.
//
// Every exit — a button, Escape, the backdrop, a navigation, being replaced —
// runs through the same `settle`, and `settle` removes the keydown listener on
// all of them. Removing it only in the Escape branch (as this used to) left one
// capture-phase listener behind per dialog ever shown, so pressing Escape in a
// later dialog ran the stale handler first, which wiped #dialog-root and closed
// the dialog the user was actually looking at.
let open = null;

export const dialog = {
    CANCELLED,

    // Yes/no, resolved with true or false.
    //
    // A dismissal is folded into false rather than passed through as the
    // sentinel: every call site asks a yes/no question, and CANCELLED is a
    // truthy symbol — passing it through would have turned "the user pressed
    // Cancel" into "yes, do the destructive thing" at all fifteen of them.
    async confirm(messageKey) {
        const answer = await this.choose(messageKey, [
            { label: "common.confirm", value: true, class: "primary", icon: "check" },
            { label: "common.cancel", class: "", icon: "close" }
        ]);
        return answer === CANCELLED ? false : answer;
    },

    // Arbitrary options. Each is
    //   { label: i18nKey, class?, icon?, value?, action? }
    // and an option with neither `value` nor `action` is the cancel half of the
    // pair. `action(close)` closes the dialog with a value of its choosing, which
    // is what lets a form validate before it accepts.
    choose(messageKey, options) {
        return this._present(messageKey, { options });
    },

    // A dialog whose body the caller builds, for the ones that are small forms
    // rather than questions — the password and owner-number prompts in settings,
    // the category name, the person picker, which each need one or two inputs and
    // their own validation.
    //
    // `body(close)` and `submit(close)` both get the settle function, so a body
    // that itself decides (a chooser: tapping a row picks it) and a body that is
    // confirmed by a button can share one implementation.
    //
    // Confirm does not close the dialog on its own. `submit(close)` runs instead,
    // and closes only once the input is acceptable, so a short password leaves the
    // dialog open with the reason on it rather than vanishing and taking the
    // typed value with it. Pass `submit: null` for a dialog whose body makes the
    // choice itself — a chooser needs no confirm button, and a dead one is worse
    // than none. Pass `messageKey: null` for a dialog whose title already says
    // everything it needs to, rather than printing the title twice.
    //
    // `titleParams` is for a title with a word in it — "New income" rather than
    // "New transaction" — so a caller whose answer is a choice does not have to
    // invent a second key per choice to say which one this dialog is.
    form(messageKey, {
        body,
        submit = null,
        titleKey = null,
        titleParams = null,
        submitLabel = "common.confirm",
        submitIcon = "check"
    }) {
        const options = submit === null
            ? []
            : [{ label: submitLabel, class: "primary", icon: submitIcon, action: submit }];
        return this._present(messageKey, {
            titleKey,
            titleParams,
            options,
            // Every dialog can be closed, whatever else it offers.
            alwaysCancel: true,
            build: close => body(close),
            focusFirstField: true
        });
    },

    // Closes whatever is open. Any pending promise resolves with CANCELLED,
    // which every call site already treats as "cancelled".
    close() {
        if (open) open.close();
    },

    _present(messageKey, {
        options = [],
        build = null,
        focusFirstField = false,
        titleKey = null,
        titleParams = null,
        alwaysCancel = false
    } = {}) {
        return new Promise(resolve => {
            const root = document.querySelector("#dialog-root");
            if (!root) {
                resolve(CANCELLED);
                return;
            }
            // Only one can be on screen: a second replaces the first, and the
            // first is told it is closed so its caller stops waiting on a
            // question that is no longer visible.
            if (open) open.close();

            const settle = value => {
                if (!open || open.settled) return;
                open.settled = true;
                document.removeEventListener("keydown", onKey, true);
                offRoute();
                open = null;
                root.replaceChildren();
                resolve(value);
            };

            const onKey = e => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                settle(CANCELLED);
            };

            // The body is wrapped so a caller can return a single node or a list of
            // them, and so focusFirstField has one element to search rather than
            // a node or an array depending on what the caller did.
            const built = build ? build(settle) : null;
            const body = built == null ? null : h("div", { class: "dialog-body" }, built);
            // The same button factory the rest of the app uses, so a dialog
            // action is the same shape as a page action and cannot drift.
            //
            // Every press of an option answers with a pulse, because a dialog is
            // the one place in this app where a choice is made rather than an
            // action performed: on a touch screen, the confirmation is the one
            // thing that cannot be inferred from what the screen does next. The
            // ways OUT of a dialog — Escape, the backdrop, the close button —
            // deliberately do not pulse, because abandoning a question is not an
            // answer to it.
            const buttons = options.map(opt => action({
                label: t(opt.label),
                icon: opt.icon ?? null,
                tone: opt.class ?? "",
                onClick: () => {
                    haptics.do("ack");
                    if (opt.action) opt.action(settle);
                    else settle(opt.value === undefined ? CANCELLED : opt.value);
                }
            }));
            // A dialog whose body makes the choice itself (a picker) has no
            // confirm to press, but it still needs a visible way out for anyone
            // not using Escape or the backdrop.
            if (alwaysCancel) {
                buttons.push(action({
                    label: t("common.cancel"),
                    icon: "close",
                    onClick: () => settle(CANCELLED)
                }));
            }

            const dialogEl = h("div", {
                class: "dialog",
                role: "dialog",
                "aria-modal": "true",
                onClick: e => e.stopPropagation()
            },
                h("div", { class: "dialog-head" },
                    h("h2", { class: "dialog-title" }, t(titleKey || "common.confirm", titleParams)),
                    action({
                        label: null,
                        icon: "close",
                        tone: "quiet",
                        onClick: () => settle(CANCELLED),
                        title: t("common.close"),
                        ariaLabel: t("common.close")
                    })
                ),
                h("p", { class: "muted" }, messageKey ? t(messageKey) : null),
                body,
                toolbar(...buttons)
            );

            const backdrop = h("div", {
                class: "dialog-backdrop",
                onClick: () => settle(CANCELLED)
            }, dialogEl);

            const offRoute = bus.on("route", () => settle(CANCELLED));

            document.addEventListener("keydown", onKey, true);
            root.replaceChildren(backdrop);
            open = { close: () => settle(CANCELLED), settled: false };

            // Focus the primary choice, so Enter picks the answer this dialog is
            // asking for rather than whichever button happens to be first. A form
            // focuses its first field instead, because Enter in a text field
            // means "submit", not "press the highlighted button" — and the
            // confirm button there is wired to the same submit handler.
            const firstField = body?.querySelector?.("input, textarea, select");
            if (focusFirstField && firstField) firstField.focus();
            else (dialogEl.querySelector("button.primary") || buttons[0])?.focus();
        });
    }
};

// A message with nothing to decide: shown in place of a dialog body when there
// is genuinely nothing to ask. Exported so a screen that wants an informational
// dialog uses the same empty state as every empty list in the app.
export function dialogNote(text, icon = "info") {
    return emptyState(text, { icon });
}

// A single captioned control in a dialog body, wired the same way as a form
// field. Exported so the settings prompts stop assembling their own `<label>`.
export function dialogField(labelKey, control, errorId = null) {
    const error = errorId ? fieldError(errorId) : null;
    return field(t(labelKey), control, error);
}

export { caption };
