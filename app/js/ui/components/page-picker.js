import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { dialog } from "./dialog.js";
import { pickRow, list, listRow } from "./ui.js";
import { searchField } from "./fields.js";
import { PAGE_ITEM_TYPES, PAGE_ITEM_TARGETS } from "../../domain/validation.js";
import { candidatesFor } from "./page-records.js";
import { PAGE_ITEM_ICONS } from "./page-item.js";

// The two dialogs a page screen needs: "what are you adding?" and "which one?".
//
// Both go through dialog.form / dialog.choose, which is the only modal in the
// app — one owner for Escape, the backdrop and a navigation, and one cancelled
// sentinel for callers to compare against. A hand-rolled backdrop here would be
// the exact mistake finance-person-field.js stopped making.

/**
 * Ask which kind of line to add. Resolves with the kind, or dialog.CANCELLED.
 *
 * One question rather than a form with a kind dropdown, because the seven kinds
 * are seven different acts and a dropdown makes the user pick a kind before they
 * can see what picking it would ask for. Each option is named in the words the
 * row is then shown with, so a kind is recognisable once it is on the page.
 */
export function choosePageItemKind() {
    return dialog.choose("pages.addKind", PAGE_ITEM_TYPES.map(type => ({
        label: `pages.kind${cap(type)}`,
        icon: PAGE_ITEM_ICONS[type],
        value: type
    })));
}

// The kind names are stored in i18n as `pages.kindTask` and friends, so one
// function turns a stored kind into its key rather than seven conditionals.
const cap = type => type.charAt(0).toUpperCase() + type.slice(1);

/**
 * Ask which existing record a linked line should point at. Resolves with the
 * record's id, or dialog.CANCELLED.
 *
 * `type` is a page item kind; the list is whatever exists on this device for it,
 * and an account with none of that kind says so in a row rather than opening an
 * empty box the user has to interpret. Search narrows by title — the one field
 * every one of the four kinds has — and Enter takes the first match, so a
 * keyboard can get there without reaching for the arrow keys.
 */
export function chooseRecord(type) {
    if (!PAGE_ITEM_TARGETS[type]) {
        // Defensive: a kind with nothing to point at must never reach a chooser
        // that would come back empty with nothing to say why.
        return Promise.resolve(dialog.CANCELLED);
    }
    return candidatesFor(type).then(options => dialog.form(null, {
        titleKey: "pages.pickTitle",
        // No confirm: the body makes the choice itself.
        submit: null,
        body: close => {
            const { input } = searchField(t("pages.searchPlaceholder"));
            const listBox = h("ul", { class: "list" });

            const matches = () => {
                const q = input.value.trim().toLowerCase();
                return q ? options.filter(o => o.title.toLowerCase().includes(q)) : options;
            };

            const render = () => {
                const rows = matches().map(o => h("li", { key: o.id }, pickRow({
                    icon: PAGE_ITEM_ICONS[type],
                    title: o.title,
                    subtitle: o.subtitle || null,
                    onClick: () => close(o.id)
                })));
                if (rows.length === 0) {
                    // An empty chooser is still a row-shaped answer, so it is the
                    // kit's row: the same list padding and hairline either way.
                    rows.push(h("li", {}, listRow({
                        title: t(input.value.trim() ? "pages.noResults" : "pages.none"),
                        titleClass: "muted"
                    })));
                }
                listBox.replaceChildren(...rows);
            };

            input.addEventListener("input", render);
            input.addEventListener("keydown", e => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const first = matches()[0];
                if (first) close(first.id);
            });

            render();
            return [input, list(listBox)];
        }
    }));
}
