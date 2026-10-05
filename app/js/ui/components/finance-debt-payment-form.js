import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { formatMoney, toAmountInputValue } from "../../domain/money.js";
import { financeAmountField, financeDateTimeField, financeNoteField, financeSaveButton } from "./finance-fields.js";
import { formShell } from "./fields.js";

// Adding a payment to a debt — or editing one that is already there, which is
// the same form with the same fields pre-filled.
//
// `ceiling` is the largest amount this form may submit: what is still owed for
// a NEW payment, and what is still owed plus this payment's own amount for an
// existing one, because correcting a payment may legitimately raise it. It is
// only a shortcut — the service re-checks the real ceiling inside the storage
// transaction, so this form is never the guard. `remaining` is what the form
// displays, and it stays the debt's true figure either way.
export function financeDebtPaymentForm(debt, { ceiling, remaining = ceiling }, onSave, { payment = null } = {}) {
    const editing = payment || null;
    const canPay = Number.isInteger(ceiling) && ceiling > 0;
    // A new payment defaults to settling the debt in full, because that is the
    // common case; an edited one keeps exactly what was recorded.
    const amount = financeAmountField(editing ? editing.amount : (canPay ? ceiling : null), "fin-amount-error");
    const date = financeDateTimeField(editing?.occurredAt, { required: true });
    const note = financeNoteField(editing?.note);
    const save = financeSaveButton();

    if (canPay) amount.input.max = toAmountInputValue(ceiling);

    const form = formShell([
        h("p", { class: "muted" },
            `${t("finance.remaining")}: ${formatMoney(Number.isInteger(remaining) ? remaining : 0, debt?.currency)}`),
        amount.node,
        date.node,
        note.node
    ], save);

    form.addEventListener("submit", async e => {
        e.preventDefault();
        amount.error.textContent = "";

        const minor = amount.read();
        if (minor == null || minor <= 0) {
            amount.error.textContent = t("error.out_of_range");
            amount.input.focus();
            return;
        }
        if (canPay && minor > ceiling) {
            amount.error.textContent = t("error.exceeds_remaining");
            amount.input.focus();
            return;
        }

        save.disabled = true;
        try {
            await onSave({ amount: minor, occurredAt: date.read(), note: note.read() });
        } finally {
            save.disabled = false;
        }
    });

    return form;
}
