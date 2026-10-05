import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import {
    financeTitleField,
    financeAmountField,
    financeDirectionField,
    financeCategoryField,
    financeDateField,
    financeNoteField,
    financeSaveButton
} from "./finance-fields.js";
import { field, formShell } from "./fields.js";
import { action } from "./ui.js";
import { categoryService } from "../../services/category-service.js";
import { openPersonPicker } from "./finance-person-field.js";

// Async because the category select is built from the categories store, which
// is a read — callers must await this before appending the node.
//
// The person is NOT resolved here. Picking a person opens a dialog as a
// deliberate user action (a button), never as a side effect of building the
// form; the picked { personId, person } is handed to the service, which is the
// only place that decides whether a name means an existing person or a new one.
export async function financeDebtForm(debt, onSave) {
    const categories = await categoryService.list();
    const direction = financeDirectionField(debt?.direction ?? "owed_by_me");
    const title = financeTitleField(debt?.title || "");
    // The original amount only. Paid and remaining are derived from the
    // payments on every read, so they have no field to be edited into.
    const amount = financeAmountField(debt?.amount, "fin-amount-error");
    const category = financeCategoryField(categories, debt?.category ?? null);
    const dueAt = financeDateField(debt?.dueAt, { empty: true, label: t("finance.dueDate") });
    const note = financeNoteField(debt?.note);
    const save = financeSaveButton();

    let who = { personId: debt?.personId ?? null, person: debt?.person ?? null };

    const whoLabel = h("span", { class: "who-name" },
        who.person ? who.person : t("finance.people.personNone"));
    const pick = action({
        label: t("finance.people.pickPerson"),
        icon: "person",
        onClick: async () => {
            const picked = await openPersonPicker(who);
            if (!picked) return;
            who = picked;
            whoLabel.textContent = who.person ? who.person : t("finance.people.personNone");
        }
    });
    const clear = action({
        label: t("finance.people.clearPerson"),
        icon: "close",
        tone: "quiet",
        onClick: () => {
            who = { personId: null, person: null };
            whoLabel.textContent = t("finance.people.personNone");
        }
    });

    const form = formShell([
        direction.node,
        title.node,
        field(t("finance.person"), h("span", { class: "who-picker" }, whoLabel, pick, clear)),
        amount.node,
        category.node,
        dueAt.node,
        note.node
    ], save);

    form.addEventListener("submit", async e => {
        e.preventDefault();
        title.error.textContent = "";
        amount.error.textContent = "";

        const value = title.read();
        if (!value) {
            title.error.textContent = t("error.required");
            title.input.focus();
            return;
        }
        const minor = amount.read();
        if (minor == null || minor <= 0) {
            amount.error.textContent = t("error.out_of_range");
            amount.input.focus();
            return;
        }

        save.disabled = true;
        try {
            await onSave({
                direction: direction.read(),
                title: value,
                personId: who.personId,
                person: who.person,
                amount: minor,
                category: category.read(),
                dueAt: dueAt.read(),
                note: note.read()
            });
        } finally {
            save.disabled = false;
        }
    });

    return form;
}
