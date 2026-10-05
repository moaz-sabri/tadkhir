import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { uiIcon } from "../icons.js";
import { action } from "./ui.js";

// Form controls, one shape each.
//
// The field wrapper, the caption, the error line and the Save button used to be
// written out by hand in seven forms, in three slightly different versions: the
// Later form passed its captions as bare text nodes (so they rendered as
// unstyled browser text rather than the grey micro-caption every other field
// had), and it left the `.field-error` class off its error lines (so a required
// message arrived in grey with no red box while the same failure in the Finance
// forms arrived in red). One definition here removes that whole class of drift.
//
// Two rules the controls follow:
//   * A caption is always a `<span class="label">` inside the `<label>`, never a
//     bare text node — the caption is what tells the reader which field is which
//     once there are six of them stacked.
//   * An error line exists in the DOM from the start and takes up no space while
//     empty (`role="status"` has to be there before the text arrives for the
//     announcement to be picked up).

// The grey micro-caption above a control.
export function caption(text) {
    return h("span", { class: "label" }, text);
}

// A caption, the control, and — where the control can fail on its own — the line
// that says so. Always a `<label>`, so clicking the caption focuses the control
// without any extra wiring. `extra` is appended after the error line, for the
// cases where a control also has a button of its own beneath it.
export function field(label, control, error = null, ...extra) {
    return h("label", { class: "field" },
        typeof label === "string" ? caption(label) : label,
        control,
        error,
        ...extra
    );
}

// The line under a control. Empty and zero-height until it has something to say,
// so no form ever shows an empty red box.
export function fieldError(id) {
    return h("p", { id, class: "field-error", role: "status" });
}

// A group of fields that is not a control in its own right — a nested box of
// subtasks, a two-up pair on a wide screen.
export function fieldGroup(...children) {
    return h("div", { class: "field-group" }, ...children);
}

// A horizontal pair. Collapses to one column when there is not enough width for
// both, rather than squeezing them.
export function fieldRow(...children) {
    return h("div", { class: "field-row" }, ...children);
}

// Every form is this: a noValidate form (the app reports failures itself, in the
// field that caused them), the fields, and the submit control last.
export function formShell(fields, submit) {
    return h("form", { class: "form", noValidate: true },
        ...[].concat(fields).filter(Boolean),
        h("div", { class: "form-actions" }, submit)
    );
}

// The submit control of every form: the word, plus the check that says it saves.
export function saveButton(label = null) {
    return h("button", { class: "btn primary", type: "submit" },
        uiIcon("check", { className: "icon btn-icon" }),
        label ?? t("common.save")
    );
}

// ------------------------------------------------------------- disclosures --

// A group of fields that is not on screen until somebody asks for it: the button,
// and the box it opens.
//
// This is not a "show more" text link and not a collapsible section. It is the
// same fields, in the same order, wired to the same reads — held out of the way
// until they are wanted — so the form a person reads on the ninety-nine days
// nothing unusual happened is three fields long, and the form on the day
// something did happen is the same form with one press between the two.
//
// `open` says which way it starts, and a caller that has a value to show (an
// existing record, a prefilled category) starts it open rather than hiding
// something it just wrote into it.
export function moreFields(label, children, { icon = "sliders", open = false } = {}) {
    const body = h("div", { class: "more-body" }, ...children);
    body.hidden = !open;

    const toggle = action({
        label,
        icon,
        tone: "quiet",
        className: "more-toggle",
        // The state is on the button, not only in the chevron: this is the one
        // control in the app whose label does not change when it is pressed, so
        // `aria-expanded` is what tells a screen reader whether the fields are
        // there.
        onClick: () => {
            const next = body.hidden;
            body.hidden = !next;
            toggle.setAttribute("aria-expanded", String(next));
        }
    });
    toggle.setAttribute("aria-expanded", String(open));

    return {
        element: h("div", { class: "more" }, toggle, body),
        body,
        toggle,
        open: () => {
            if (!body.hidden) return;
            body.hidden = false;
            toggle.setAttribute("aria-expanded", "true");
        }
    };
}

// ------------------------------------------------------------- searching ----

// A search field with a magnifier in it and a way to clear it.
//
// The clear button is the point: without it, clearing a query means selecting
// the text and deleting it eight times, and a search that cannot be emptied
// without a keyboard is a search half the app cannot use. It appears only when
// there is something to clear, and takes the same 44px target as every other
// control.
//
// The returned element IS the input, so a caller wires it exactly as it would a
// bare one.
export function searchField(placeholder, { onInput = null } = {}) {
    const input = h("input", {
        type: "search",
        class: "search-input",
        autocomplete: "off",
        "aria-label": placeholder,
        placeholder
    });
    const clear = h("button", {
        class: "search-clear",
        type: "button",
        "aria-label": t("common.clear"),
        title: t("common.clear"),
        hidden: true,
        onClick: () => {
            input.value = "";
            sync();
            input.focus();
            input.dispatchEvent(new Event("input", { bubbles: true }));
        }
    }, uiIcon("close", { className: "icon icon-sm" }));

    const sync = () => { clear.hidden = input.value === ""; };
    input.addEventListener("input", () => { sync(); if (onInput) onInput(); });

    return {
        input,
        element: h("div", { class: "search" },
            h("span", { class: "search-glyph" }, uiIcon("search", { className: "icon icon-sm" })),
            input,
            clear
        )
    };
}

// A search field, for the common case where the caller only wants the input.
export function searchInput(placeholder, onInput = null) {
    return searchField(placeholder, { onInput }).input;
}

// ------------------------------------------------------------ selecting -----

// A `<select>` with a chevron drawn in the same style as every other icon, in
// the same place, in both languages.
//
// This replaced a `linear-gradient` arrow pinned to `100%` — which is the
// physical right edge, so on an Arabic page the arrow sat on the wrong side of
// the field, on the end the user reads from. The chevron is logical now, so it
// moves with the writing direction like everything else.
//
// The returned element is the `<select>`, so a caller reads and writes it
// directly. Pass `ariaLabel` where there is no visible caption.
export function selectControl({ options = [], value = null, ariaLabel = null, onChange = null } = {}) {
    const select = h("select", { "aria-label": ariaLabel },
        ...options.map(o => h("option", { value: o.value }, o.label))
    );
    if (value != null) select.value = String(value);
    if (onChange) select.addEventListener("change", onChange);
    return {
        select,
        element: h("div", { class: "select" },
            select,
            h("span", { class: "select-caret" }, uiIcon("chevronDown", { className: "icon icon-sm" }))
        )
    };
}

// ------------------------------------------------------------- settings -----

// One row of a settings screen: a glyph, a name, an optional line saying what
// the setting does, and the control.
//
// Settings used to be the one page in the app with no structure at all — bare
// labels, controls and rows of buttons, with two hairlines doing the work of
// section headings. It now uses the same row shape as every list in the app, so
// the settings page reads as the same design as the rest of it.
//
// The control moves onto its own line below the name once the row runs out of
// width, which is what makes a long label in Arabic survivable on a 320px
// screen.
//
// `id` names the ROW, and the visible name inside it becomes `<id>-label`. A
// control that draws no text of its own points its `aria-labelledby` at that —
// deliberately by hand rather than automatically, because the right target is not
// always the element being passed in: `toggleRow` hands over a `<label>` wrapper,
// and the attribute belongs on the input inside it.
export function settingRow({ icon, label, hint = null, control = null, id = null } = {}) {
    return h("div", { class: "setting-row", id },
        icon ? h("span", { class: "setting-glyph" }, uiIcon(icon, { className: "icon" })) : null,
        h("div", { class: "setting-body" },
            h("span", { class: "setting-label", id: id ? `${id}-label` : null }, label),
            hint ? h("span", { class: "setting-hint muted small" }, hint) : null
        ),
        control ? h("div", { class: "setting-control" }, control) : null
    );
}

/**
 * A row whose control is on or off — the shape every phone settings screen has
 * for a preference, and the one that reads fastest with a thumb.
 *
 * The control is a genuine `input[type=checkbox]` with `role="switch"`, so the
 * on/off state is announced as on and off rather than as checked and unchecked,
 * the whole row is reachable and operable from the keyboard, and nothing about
 * it depends on a pointer. The knob moves with `inset-inline-start`, so it
 * travels the right way in Arabic with no direction-specific rule anywhere.
 *
 * `id` is required: it names the control, which draws no text of its own.
 */
export function toggleRow({ id, icon, label, hint = null, checked = false, onChange = null } = {}) {
    const input = h("input", {
        type: "checkbox",
        class: "sr-only",
        role: "switch",
        "aria-labelledby": `${id}-label`
    });
    input.checked = !!checked;
    // The control is handed back to the callback as well as the new value, so a
    // caller that fails to save can put the switch back where it was without
    // going looking for it in the document by id.
    if (onChange) input.addEventListener("change", () => onChange(input.checked, input));
    return settingRow({
        icon,
        label,
        hint,
        id,
        control: h("label", { class: "switch" },
            input,
            h("span", { class: "switch-track" })
        )
    });
}
