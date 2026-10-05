import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { dialog } from "./dialog.js";
import { toast } from "./toast.js";
import { financeService } from "../../services/finance-service.js";
import { categoryService } from "../../services/category-service.js";
import { moreFields } from "./fields.js";
import {
    financeTitleField,
    financeAmountField,
    financeCategoryField,
    financeDateTimeField,
    financeDateField,
    financeFrequencyField,
    financeReminderField,
    financeNoteField,
    financePersonField
} from "./finance-fields.js";

// The three "write one thing down" dialogs: a transaction, a recurring rule, a
// debt.
//
// A DIALOG, not a page, because each of these is one fact and pages are for
// staying. They were pages because the form was assembled before anybody decided
// what a form has to ask, and it asked six or eight questions for the two or three
// that are true almost every time — including the ones the CALLER had already
// answered. The direction is in the button that opened the dialog. A one-off
// payment happened today. A debt's person is a name, and a name the service
// already knows how to resolve.
//
// So each is a small form in two tiers: the fields the answer needs, and the rest
// behind one button. The extras are not decoration and not a second, lesser form
// — the same fields with the same reads and the same validation, held out of the
// way until they are wanted, so the form on an ordinary day is two fields and the
// form on the unusual day is one press away from being the same.
//
// THE TYPE AND THE DIRECTION ARE NOT IN THE FORM AT ALL. Not hidden behind the
// extras either: not in it. They are in the BUTTON — "Add income", "Add expense",
// "Owed to me", "I owe" — which is the only place they were ever true, because a
// person who has just pressed "add expense" has already answered that question and
// a second copy of it is a second chance to disagree with them. The pickers stay
// on the edit forms, where changing one is a real request rather than a re-ask.
//
// One implementation for every way in — the corner button, /quick, the "add" pair
// at the top of each list, and the deep link a launcher shortcut opens. The routes
// still exist (a shortcut points at one); they open this instead of a page of
// their own.

// What the dialog asks for before it is written, and the defaults it assumes.
// Written down here rather than spread across three functions because they are
// three statements of the same rule: the common case needs no typing beyond the
// number.
const DEFAULT_REMINDER_DAYS = 1;

// The shell all three share: the fields, the disclosure that holds the rest, and
// a submit that writes only once the answer is acceptable.
//
// `collect()` returns the patch, or an error to show — which is why the dialog
// stays open on a failure with the typed values in it, instead of vanishing and
// taking the amount with it. `write()` is the service call, run before the close
// so a rejected write is reported on the form that caused it.
//
// The guard is there because the submit is a plain click on a dialog button with
// nothing disabling it: two taps on a slow write is two records.
async function quickDialog({ titleKey, titleParams = null, essential, extra, collect, write, openExtras = false }) {
    const extras = moreFields(t("finance.moreOptions"), extra, { open: openExtras });

    // The dialog's own settle function, which only exists once the dialog is up.
    // Enter in a field has to reach it, so it is held here rather than captured
    // from the confirm button's handler.
    let close = () => {};

    let saving = false;
    const fire = async () => {
        if (saving) return;
        const patch = collect();
        if (patch.error) {
            patch.error.textContent = patch.message;
            patch.error.input.focus();
            return;
        }
        saving = true;
        try {
            const record = await write(patch.value);
            // Only now. A write that fails leaves the dialog open with everything
            // typed into it, which is the only version of this a person can recover
            // from.
            close(record);
        } catch (e) {
            toast.show(`error.${e?.code || "unexpected"}`);
        } finally {
            saving = false;
        }
    };

    // Built with `h()` and not appended to: `h()` drops the null a caller leaves for
    // a field it did not need, while `append()` — like `replaceChildren()` —
    // stringifies it, and a form with the word "undefined" above it is a form
    // nobody trusts.
    //
    // Enter is the confirm button: a form whose whole answer is a title and a number
    // has exactly one question, so the keyboard can answer it. The guard above covers
    // both ways in.
    const form = h("form", {
        class: "form",
        noValidate: true,
        onSubmit: e => { e.preventDefault(); fire(); }
    },
        ...essential,
        extras.element
    );

    const record = await dialog.form(null, {
        titleKey,
        titleParams,
        submitLabel: "common.save",
        submitIcon: "check",
        body: () => form,
        submit: c => { close = c; fire(); }
    });
    return record === dialog.CANCELLED ? null : record;
}

// The two failures every one of these three forms can report, and the two fields
// they point at. A form that has a title and an amount has exactly these two ways
// to be unacceptable.
function readTitleAndAmount(title, amount) {
    const value = title.read();
    if (!value) {
        return { error: title.error, message: t("error.required"), input: title.input };
    }
    const minor = amount.read();
    if (minor == null || minor <= 0) {
        return { error: amount.error, message: t("error.out_of_range"), input: amount.input };
    }
    return { value: value, amount: minor };
}

/**
 * A transaction: a title and an amount. That is the whole form.
 *
 * `type` is the button's, not the form's, and it is required — see the note at the
 * top of this file. The date is today, prefilled and hidden, because a payment
 * being written down is a payment that happened; the category and the note are for
 * the days when there is something to say.
 *
 * `title` is what a share left parked: the text the user shared is already the
 * answer to this field, so it arrives filled in rather than as a question.
 */
export async function openQuickTransaction({ type = "expense", title = "" } = {}) {
    const categories = await categoryService.list();
    const heading = financeTitleField(title);
    const amount = financeAmountField(null);
    const date = financeDateTimeField(Date.now());
    const category = financeCategoryField(categories, null);
    const note = financeNoteField(null);

    return quickDialog({
        // "New {type}" with the direction's own noun, so the dialog says what it is
        // for rather than "New transaction" over a form that only makes sense for
        // one of the two.
        titleKey: "finance.newTransactionOf",
        titleParams: { type: t(`finance.${type}Type`) },
        essential: [heading.node, amount.node],
        extra: [date.node, category.node, note.node],
        collect: () => {
            const read = readTitleAndAmount(heading, amount);
            if (read.error) return read;
            return {
                value: {
                    type,
                    title: read.value,
                    amount: read.amount,
                    occurredAt: date.read(),
                    category: category.read(),
                    note: note.read()
                }
            };
        },
        write: patch => financeService.createTransaction(patch)
    });
}

/**
 * A recurring rule: a title, an amount, and how often.
 *
 * Those three are the whole of a rule, and the date it starts on is today and the
 * reminder is the day before — both of which are what a new rule means unless
 * something else is true of it. They are behind the button rather than filled in
 * front of the person, because a form that opens with a date already filled in is
 * a form that asks to be checked rather than a form that is ready.
 */
export async function openQuickRecurring({ type = "expense" } = {}) {
    const categories = await categoryService.list();
    const heading = financeTitleField("");
    const amount = financeAmountField(null);
    const frequency = financeFrequencyField("monthly");
    const anchor = financeDateField(null, { required: true, label: t("finance.startDate") });
    const reminder = financeReminderField(DEFAULT_REMINDER_DAYS);
    const category = financeCategoryField(categories, null);
    const note = financeNoteField(null);

    return quickDialog({
        titleKey: "finance.newRecurring",
        essential: [heading.node, amount.node, frequency.node],
        extra: [anchor.node, reminder.node, category.node, note.node],
        collect: () => {
            const read = readTitleAndAmount(heading, amount);
            if (read.error) return read;
            const anchorAt = anchor.read();
            if (anchorAt == null) {
                return { error: anchor.error, message: t("error.required"), input: anchor.input };
            }
            return {
                value: {
                    type,
                    title: read.value,
                    amount: read.amount,
                    frequency: frequency.read(),
                    anchorAt,
                    reminderDays: reminder.read(),
                    category: category.read(),
                    note: note.read()
                }
            };
        },
        write: patch => financeService.createRecurring(patch)
    });
}

/**
 * A debt: whose, what for, how much.
 *
 * Which side of the money it is on is the button's and not in here. The person is a
 * name, which the service resolves against the people store and creates if it is
 * new — see financePersonField for why this is a field and not the chooser the
 * page form uses.
 */
export async function openQuickDebt({ direction = "owed_by_me" } = {}) {
    const categories = await categoryService.list();
    const heading = financeTitleField("");
    const who = financePersonField(null);
    const amount = financeAmountField(null);
    const dueAt = financeDateField(null, { empty: true, label: t("finance.dueDate") });
    const category = financeCategoryField(categories, null);
    const note = financeNoteField(null);

    return quickDialog({
        titleKey: "finance.newDebt",
        essential: [heading.node, who.node, amount.node],
        // The due date is a detail, not the point of the debt: it has no default,
        // most debts are written down without one, and a date field that opens
        // empty is a field that has to be read past on the days it stays empty.
        extra: [dueAt.node, category.node, note.node],
        collect: () => {
            const read = readTitleAndAmount(heading, amount);
            if (read.error) return read;
            return {
                value: {
                    direction,
                    title: read.value,
                    personId: null,
                    person: who.read(),
                    amount: read.amount,
                    dueAt: dueAt.read(),
                    category: category.read(),
                    note: note.read()
                }
            };
        },
        write: patch => financeService.createDebt(patch)
    });
}
