import { h } from "../dom.js";
import { uiIcon } from "../icons.js";

// The one two-way icon picker, for every field in the app that has exactly two
// answers: money in/out, who owes whom, link/note. Extracted from
// finance-fields.js so a second feature with a two-way choice uses the same
// control instead of copying it — same markup, same `.icon-picker` styling
// hooks, same behaviour.
//
// The radio is real on purpose: keyboard arrows and aria come for free, and the
// visible box is the label, styled from the :checked state of the input inside
// it (see .icon-face in components.css). The glyphs come from the shared
// registry in ui/icons.js like every other icon in the app — and they are named
// there rather than passed in as path data, so a screen picks "moneyIn" out of
// the registry instead of carrying its own private copy of the arrow.
//
// Radio group names must be unique per instance, not per page: one page can
// mount an edit form next to an "add" form, and two groups sharing a name
// would make the browser cross-wire them. One counter for the whole app, so a
// finance picker and a Later picker can never land on the same name.
let pickerSeq = 0;

// `icons` and `labels` are keyed by option, `options` is ordered, and its first
// entry is both the default and the reading-order first item.
export function iconPicker({ group, label, icons, labels, options, value }) {
    const name = `${group}-${++pickerSeq}`;
    const selected = options.includes(value) ? value : options[0];
    const items = options.map(kind => {
        const input = h("input", {
            type: "radio",
            class: "sr-only",
            name,
            value: kind,
            checked: kind === selected
        });
        return {
            kind,
            input,
            node: h("label", { class: "icon-option" },
                input,
                h("span", { class: "icon-face" },
                    uiIcon(icons[kind]),
                    h("span", { class: "icon-face-text" }, labels[kind])
                )
            )
        };
    });
    return {
        node: h("fieldset", { class: "icon-picker" },
            h("legend", {}, label),
            h("div", { class: "icon-options" }, ...items.map(i => i.node))
        ),
        read: () => items.find(i => i.input.checked)?.kind ?? selected,
        onChange: fn => items.forEach(i => i.input.addEventListener("change", fn))
    };
}
