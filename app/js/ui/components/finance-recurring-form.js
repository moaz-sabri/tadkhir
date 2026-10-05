import { t } from "../../i18n/i18n.js";
import {
    financeTitleField,
    financeAmountField,
    financeTypeField,
    financeCategoryField,
    financeDateField,
    financeFrequencyField,
    financeReminderField,
    financeNoteField,
    financeSaveButton
} from "./finance-fields.js";
import { formShell } from "./fields.js";
import { categoryService } from "../../services/category-service.js";

// Async because the category select is built from the categories store, which
// is a read — callers must await this before appending the node.
export async function financeRecurringForm(recurring, onSave) {
    const categories = await categoryService.list();
    const type = financeTypeField(recurring?.type ?? "expense");
    const title = financeTitleField(recurring?.title || "");
    const amount = financeAmountField(recurring?.amount, "fin-amount-error");
    // The anchor is the day the cycle counts from, so it is both "the first
    // due date" and the anchor every later occurrence is derived from.
    const anchor = financeDateField(recurring?.anchorAt, { required: true, label: t("finance.startDate") });
    const frequency = financeFrequencyField(recurring?.frequency ?? "monthly");
    const reminder = financeReminderField(recurring?.reminderDays ?? null);
    const category = financeCategoryField(categories, recurring?.category ?? null);
    const note = financeNoteField(recurring?.note);
    const save = financeSaveButton();

    const form = formShell([
        type.node,
        title.node,
        amount.node,
        frequency.node,
        anchor.node,
        reminder.node,
        category.node,
        note.node
    ], save);

    form.addEventListener("submit", async e => {
        e.preventDefault();
        title.error.textContent = "";
        amount.error.textContent = "";
        anchor.error.textContent = "";

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
        const anchorAt = anchor.read();
        if (anchorAt == null) {
            // Said out loud as well as focused — see finance-transaction-form.js.
            anchor.error.textContent = t("error.required");
            anchor.input.focus();
            return;
        }

        save.disabled = true;
        try {
            await onSave({
                type: type.read(),
                title: value,
                amount: minor,
                frequency: frequency.read(),
                anchorAt,
                reminderDays: reminder.read(),
                category: category.read(),
                note: note.read()
            });
        } finally {
            save.disabled = false;
        }
    });

    return form;
}
