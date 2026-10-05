import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { peopleService, sameName } from "../../services/people-service.js";
import { dialog } from "./dialog.js";
import { pickRow, list, listRow } from "./ui.js";
import { searchField } from "./fields.js";

// Opens the "pick someone, or type a new name" dialog.
//
// Returns { personId, person } for the chosen person, or { personId: null,
// person: "<typed name>" } when the user typed a name that is not on file — the
// service turns that into a real person on save. Resolves with dialog.CANCELLED
// if dismissed.
//
// A new name is never created here: picking someone and saving the debt are two
// separate steps, and creating a person for a dialog the user then cancels would
// leave an orphan behind.
//
// This was a hand-rolled `.dialog-backdrop` with its own markup, no Escape
// handling and no route handling, so a navigation while it was open left it on
// screen over the page that had replaced it, and a second dialog stacked on top
// of it. It goes through dialog.form now: one lifecycle, one owner for Escape,
// the backdrop and the route — and it resolves with the same CANCELLED sentinel
// as every other dialog, which is why the `orNull`-style adapter it needed is
// gone.
export function openPersonPicker(current = null) {
    return peopleService.list().then(people => dialog.form(
        // No message under the title: the title is the whole instruction, and
        // printing it twice is what a chooser did before it joined this dialog.
        null,
        {
            titleKey: "finance.people.pickPerson",
            // No confirm button: the body makes the choice itself, so a confirm
            // here would have nothing to confirm.
            submit: null,
            body: close => {
                const { input } = searchField(t("finance.people.searchPlaceholder"));
                const listBox = h("ul", { class: "list" });

                const matches = () => {
                    const q = input.value.trim().toLowerCase();
                    return q ? people.filter(p => p.name.toLowerCase().includes(q)) : people;
                };

                // Rebuilt in one pass on every keystroke. Building the "add this
                // name" row inside the same render is what keeps it from
                // disappearing: the earlier version prepended it separately, and
                // the next re-render wiped the node it was holding.
                const render = () => {
                    const q = input.value.trim();
                    const rows = [];
                    if (q && !people.some(p => sameName(p.name, q))) {
                        rows.push(h("li", { key: "__new" }, pickRow({
                            icon: "plus",
                            title: t("finance.people.addAsName", { name: q }),
                            subtitle: t("finance.people.willCreate"),
                            onClick: () => close({ personId: null, person: q })
                        })));
                    }
                    for (const p of matches()) {
                        rows.push(h("li", { key: p.id }, pickRow({
                            icon: "person",
                            title: p.name,
                            subtitle: p.note || null,
                            onClick: () => close({ personId: p.id, person: p.name })
                        })));
                    }
                    if (rows.length === 0) {
                        // An empty chooser is still a row-shaped answer, so it is
                        // the kit's row and not a bare paragraph: the list's own
                        // padding and hairline stay consistent either way.
                        rows.push(h("li", {}, listRow({
                            title: t(q ? "finance.people.noResults" : "finance.people.noPeople"),
                            titleClass: "muted"
                        })));
                    }
                    listBox.replaceChildren(...rows);
                };

                input.addEventListener("input", render);
                input.addEventListener("keydown", e => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    const q = input.value.trim();
                    if (!q) return;
                    // Enter on an exact existing name picks that person;
                    // anything else is a new name, which is what the first row
                    // offered too.
                    const exact = people.find(p => sameName(p.name, q));
                    close(exact ? { personId: exact.id, person: exact.name } : { personId: null, person: q });
                });

                render();
                return [input, list(listBox)];
            }
        }
    ));
}
