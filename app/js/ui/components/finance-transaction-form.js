import { t } from "../../i18n/i18n.js";
import {
    financeTitleField,
    financeAmountField,
    financeTypeField,
    financeCategoryField,
    financeDateTimeField,
    financeNoteField,
    financeSaveButton
} from "./finance-fields.js";
import { formShell } from "./fields.js";
import { categoryService } from "../../services/category-service.js";

// Async because the category select is built from the categories store, which
// is a read — callers must await this before appending the node.
export async function financeTransactionForm(transaction, onSave) {
    const categories = await categoryService.list();
    const type = financeTypeField(transaction?.type ?? "expense");
    const title = financeTitleField(transaction?.title || "");
    const amount = financeAmountField(transaction?.amount, "fin-amount-error");
    const date = financeDateTimeField(transaction?.occurredAt, { required: true });
    const category = financeCategoryField(categories, transaction?.category ?? null);
    const note = financeNoteField(transaction?.note);
    const save = financeSaveButton();

    const form = formShell([
        type.node,
        title.node,
        amount.node,
        date.node,
        category.node,
        note.node
    ], save);

    form.addEventListener("submit", async e => {
        e.preventDefault();
        title.error.textContent = "";
        amount.error.textContent = "";
        date.error.textContent = "";

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
        const occurredAt = date.read();
        if (occurredAt == null) {
            // Said out loud as well as focused: an empty or half-typed date
            // returns null, and a control that only moves the focus leaves the
            // user pressing Save again against a button that appears broken.
            date.error.textContent = t("error.required");
            date.input.focus();
            return;
        }

        save.disabled = true;
        try {
            await onSave({
                type: type.read(),
                title: value,
                amount: minor,
                occurredAt,
                category: category.read(),
                note: note.read()
            });
        } finally {
            save.disabled = false;
        }
    });

    return form;
}
