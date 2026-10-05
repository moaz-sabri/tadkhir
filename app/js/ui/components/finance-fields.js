import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { iconPicker } from "./icon-picker.js";
import { field, fieldError, selectControl, saveButton } from "./fields.js";
import { toMinorUnits, toAmountInputValue } from "../../domain/money.js";
import {
    FINANCE_REMINDER_DAYS,
    FINANCE_DEBT_DIRECTIONS,
    FINANCE_FREQUENCIES,
    MAX_TITLE,
    MAX_NOTE
} from "../../domain/validation.js";
import {
    toDateInputValue,
    fromDateInputValue,
    toDateTimeInputValue,
    fromDateTimeInputValue,
    formatDate,
    startOfDay
} from "../../domain/time.js";
import { isDue } from "../../domain/finance.js";

// The field factories every Finance form is built from. Keeping them here is
// what makes the four forms look and behave the same way: the same label
// order, the same error paragraph wiring, the same minor-unit handling.
//
// The field wrapper, the caption and the error line are NOT defined here — they
// come from fields.js, the shared kit, and the task form and the Later form use
// the same three. That is the difference between "the Finance forms agree with
// each other" and "every form in the app agrees with every other form".
//
// Note on currency: there is no currency input on purpose. Finance is
// single-currency by design (no conversion, no rates), so new records take
// DEFAULT_CURRENCY and an edit never rewrites the currency of an existing
// record — the field only exists in the data model.

export function financeTitleField(value = "", errorId = "fin-title-error") {
    const input = h("input", {
        type: "text",
        required: true,
        maxLength: MAX_TITLE,
        value,
        autocomplete: "off",
        "aria-describedby": errorId
    });
    const error = fieldError(errorId);
    return {
        input,
        error,
        node: field(t("finance.titleField"), input, error),
        read: () => input.value.trim()
    };
}

// Amount as a decimal string in, integer minor units out. The same primitive
// backs every money field, so no form can ever hand a float to a service.
export function financeAmountField(minor, errorId = "fin-amount-error") {
    const input = h("input", {
        type: "number",
        class: "money-input",
        step: "0.01",
        min: "0.01",
        inputMode: "decimal",
        required: true,
        value: Number.isInteger(minor) ? toAmountInputValue(minor) : "",
        "aria-describedby": errorId
    });
    const error = fieldError(errorId);
    return {
        input,
        error,
        node: field(t("finance.amount"), input, error),
        read: () => toMinorUnits(input.value),
        reset: () => { input.value = ""; }
    };
}

// Two big tap targets instead of a dropdown: the direction is one of the first
// decisions on every record, and a list to open it is one tap more for no gain.
// Real radios, so keyboard arrows and screen readers get the native behaviour
// for free; the visible box is the label, styled from the `:checked` state of
// the input inside it. The picker itself is shared with any other two-way field
// (see icon-picker.js) — these two only NAME the glyph and the word, both from
// the one registry, so the arrow on this form and the arrow on the home screen's
// shortcut are the same drawing by construction.
const TYPE_ICONS = {
    income: "moneyIn",
    expense: "moneyOut"
};

// A debt is not a completed flow, so it gets the hand: it sits on the side the
// money travels FROM. Owed to me — my hand below, the amount rising out of it.
// Owed by me — my hand above, the amount falling away from it. Same up/down
// reading as income/expense, with the cup saying whose side this is.
const DIRECTION_ICONS = {
    owed_to_me: "owedToMe",
    owed_by_me: "owedByMe"
};

export function financeTypeField(value = "expense") {
    return iconPicker({
        group: "fin-type",
        label: t("finance.type"),
        icons: TYPE_ICONS,
        labels: { expense: t("finance.expenseType"), income: t("finance.incomeType") },
        options: ["expense", "income"],
        value
    });
}

// Categories are free text now, so the select is built from the categories
// store at mount time. The list is a plain array of records, and a custom
// category has no translation — categoryLabel falls back to the raw name, which
// is also why the same helper is used here instead of a bare t() call.
//
// A record whose category was deleted on another device names a category that is
// no longer in the list. Rather than drop it, it is added as an option in its
// own right: the select then shows what the record actually says, and saving the
// record for an unrelated reason does not silently clear the field. (The write
// side allows that unchanged value through for the same reason — see
// assertCategoryExists in finance-service.js.)
export function financeCategoryField(categories, value = null) {
    // Guarded, not defaulted: a caller that passes the old single-argument
    // shape (a category name, or null) would otherwise crash this field with
    // "cannot read properties of null". An unknown category is simply not
    // selectable, which the write-side guard then reports properly.
    const list = Array.isArray(categories) ? categories : [];
    const known = list.some(c => c.id === value);
    const options = [
        { value: "", label: t("finance.categories.none") },
        ...list.map(c => ({ value: c.id, label: categoryLabel(c.id) })),
        // The stored value with no matching category, shown once so the record
        // reads truthfully and round-trips unchanged.
        ...(value && !known ? [{ value, label: categoryLabel(value) }] : [])
    ];
    const { select, element } = selectControl({ options, value });
    return {
        input: select,
        node: field(t("finance.category"), element),
        read: () => select.value || null
    };
}

export function financeFrequencyField(value = "monthly") {
    const { select, element } = selectControl({
        options: FINANCE_FREQUENCIES.map(f => ({ value: f, label: t(`finance.${f}`) })),
        value: FINANCE_FREQUENCIES.includes(value) ? value : "monthly"
    });
    return {
        node: field(t("finance.frequency"), element),
        read: () => select.value
    };
}

export function financeReminderField(value = null) {
    // The whitelist lives in validation.js and the select is built from it, so
    // the UI can never offer a reminder offset the validator would reject.
    const { select, element } = selectControl({
        options: [
            { value: "", label: t("finance.reminderNone") },
            ...FINANCE_REMINDER_DAYS.map(d => ({
                value: d == null ? "" : String(d),
                label: d == null
                    ? t("finance.reminderNone")
                    : d === 0 ? t("finance.reminderDue") : t("finance.reminderDays", { count: d })
            }))
        ],
        value: String(value ?? "")
    });
    return {
        node: field(t("finance.reminder"), element),
        read: () => (select.value === "" ? null : Number(select.value))
    };
}

// Who owes whom: the same two-tap picker, so the debt form answers "I owe" and
// "Owed to me" the way the transaction form answers "Expense" and "Income".
export function financeDirectionField(value = "owed_by_me") {
    return iconPicker({
        group: "fin-direction",
        label: t("finance.direction"),
        icons: DIRECTION_ICONS,
        labels: { owed_by_me: t("finance.owedByMe"), owed_to_me: t("finance.owedToMe") },
        options: [...FINANCE_DEBT_DIRECTIONS],
        value
    });
}

// A debt's person, as a NAME and nothing else.
//
// The full debt form asks for a person with a button that opens a chooser, because
// that form is a page and has somewhere for a second step to live. The quick one
// cannot: a dialog that opens a dialog replaces itself and takes the half-typed
// debt with it (see dialog.js's single-open rule). So this is a text field, and it
// loses nothing by it — `financeService.createDebt` resolves a name against the
// people store and creates the person if they are not on file, which is exactly
// what the chooser's "add as a new name" row did, in one tap instead of three.
export function financePersonField(value = null, errorId = "fin-person-error") {
    const input = h("input", {
        type: "text",
        autocomplete: "off",
        maxLength: MAX_TITLE,
        value: value ?? "",
        placeholder: t("finance.personPlaceholder"),
        "aria-describedby": errorId
    });
    const error = fieldError(errorId);
    return {
        input,
        error,
        node: field(t("finance.person"), input, error),
        read: () => input.value.trim() || null
    };
}

// A calendar day, not a moment. Empty means "not set" for the optional dates
// (debt due date) and today for the required ones.
//
// Both date fields carry an error line, because both can come back null from a
// control the user left blank or half-typed. Without one, a required date that
// failed only moved the focus and said nothing, which reads as a broken button.
export function financeDateField(ts, { required = false, label = null, empty = false, errorId = "fin-date-error" } = {}) {
    const input = h("input", {
        type: "date",
        required,
        value: toDateInputValue(ts ?? (empty ? null : startOfDay())),
        "aria-describedby": errorId
    });
    const error = fieldError(errorId);
    return {
        input,
        error,
        node: field(label ?? t("finance.date"), input, error),
        read: () => fromDateInputValue(input.value)
    };
}

// A moment, not a day — for the records that describe something that already
// happened ("I paid this at 14:35"). Pre-filled with the current date AND time
// so the common case needs no typing at all, and left fully editable for
// anything else. A due date and a recurring anchor stay on financeDateField:
// they are calendar days, and the anchor's day-of-month drives the schedule.
export function financeDateTimeField(ts, { required = true, label = null, errorId = "fin-date-error" } = {}) {
    const input = h("input", {
        type: "datetime-local",
        class: "datetime-input",
        required,
        value: toDateTimeInputValue(ts ?? Date.now()),
        "aria-describedby": errorId
    });
    const error = fieldError(errorId);
    return {
        input,
        error,
        node: field(label ?? t("finance.date"), input, error),
        read: () => fromDateTimeInputValue(input.value)
    };
}

export function financeNoteField(value = null) {
    const input = h("textarea", { maxLength: MAX_NOTE }, value || "");
    return {
        input,
        node: field(t("finance.note"), input),
        read: () => input.value
    };
}

// Small helper so each form reports the same two failures the same way.
export function financeSaveButton() {
    return saveButton();
}

// Falls back to the raw name for custom categories not in the i18n map.
// The i18n keys are only for the 7 built-ins; anything else shows as-is.
export function categoryLabel(category) {
    if (!category) return t("finance.categories.none");
    const key = `finance.categories.${category}`;
    const translated = t(key);
    return translated === key ? category : translated;
}

// Due dates are stored at local midnight, so "today" is a whole day rather
// than an instant: a rule due today is not overdue just because the clock has
// passed 00:00.
export function financeDueLabel(dueAt, now = Date.now()) {
    if (dueAt == null) return t("finance.nothingDue");
    if (startOfDay(dueAt) === startOfDay(now)) return t("finance.dueToday");
    if (isDue(dueAt, now)) return t("finance.overdue");
    return t("finance.dueOn", { date: formatDate(dueAt) });
}
