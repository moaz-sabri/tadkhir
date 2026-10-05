import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { iconPicker } from "./icon-picker.js";
import { field, fieldError, selectControl, formShell, saveButton } from "./fields.js";
import {
    ROUTINE_KINDS,
    ROUTINE_FREQUENCIES,
    ROUTINE_REMINDER_BEFORE,
    ROUTINE_REMINDER_EVERY,
    MAX_ROUTINE_TARGET,
    MAX_TITLE,
    MIN_ESTIMATE,
    MAX_ESTIMATE
} from "../../domain/validation.js";

// The routine form, for both creating and editing — the same component the task
// form and the Later form use for the same reason: an edit screen that is a
// second form is a second set of rules.
//
// The kind and the frequency decide which other fields exist, and the form shows
// exactly that: a counter has no minutes, a timed routine has no target, a daily
// routine has no weekday. The fields are hidden rather than removed, and the
// hidden ones are read as NOTHING rather than as whatever they still hold — the
// validator refuses a target on a timed routine precisely so that switching kinds
// cannot leave two shapes in one record, and a form that kept sending the old
// value would be refused for the user's own edit.
//
// Reminders come from the same closed lists the validator uses (see
// ROUTINE_REMINDER_BEFORE / _EVERY), so this form cannot offer an offset the
// record would refuse — and it says out loud what they are: a reminder the user
// set and can read back, never an appointment. The app has no push server and no
// scheduler, so nothing here starts a session or moves a deadline; the time is not
// binding, which is what makes a weekly routine a routine and not a calendar entry.

const MAX_MINUTES = MAX_ESTIMATE / 60000; // 72 * 60 = 4320
const REMINDER_BEFORE_LABELS = {
    3600000: "routine.remindHour",
    10800000: "routine.remindHours3",
    43200000: "routine.remindHours12",
    86400000: "routine.remindDay"
};

const REMINDER_EVERY_LABELS = {
    1800000: "routine.everyHalfHour",
    3600000: "routine.everyHour",
    7200000: "routine.everyHours2",
    14400000: "routine.everyHours4"
};

export function routineForm(routine, onSave) {
    const title = h("input", {
        type: "text",
        required: true,
        maxLength: MAX_TITLE,
        value: routine?.title || "",
        placeholder: t("routine.titlePlaceholder"),
        autocomplete: "off",
        "aria-describedby": "routine-title-error"
    });
    const titleError = fieldError("routine-title-error");

    // Two ways to repeat, so two big tap targets and no dropdown — the same
    // choice the money direction and the debt direction make.
    const kind = iconPicker({
        group: "routine-kind",
        label: t("routine.kind"),
        icons: { timed: "clock", counter: "target" },
        labels: { timed: t("routine.timed"), counter: t("routine.counter") },
        options: [...ROUTINE_KINDS],
        value: routine?.kind || "timed"
    });

    const frequency = selectControl({
        options: ROUTINE_FREQUENCIES.map(f => ({ value: f, label: t(`routine.frequency_${f}`) })),
        value: routine?.frequency || "daily"
    });
    const frequencyField = field(t("routine.frequency"), frequency.element);

    // Sunday first, because that is the numbering `getDay()` uses and therefore
    // the numbering the record stores. The names come from the i18n table rather
    // than from the platform's own, so a routine saved in Arabic reads in Arabic
    // on a device set to English and the day cannot be misread between them.
    const weekday = selectControl({
        options: [0, 1, 2, 3, 4, 5, 6].map(d => ({ value: String(d), label: t(`weekday.${d}`) })),
        value: String(routine?.weekday ?? 1)
    });
    const weekdayField = field(t("routine.weekday"), weekday.element);

    // Minutes, because that is what a person thinks in and it is what the task
    // estimate asks for too. Optional: a routine may be "every Friday, whenever",
    // and a run started from it is still recorded as that routine's.
    const duration = h("input", {
        type: "number",
        min: Math.round(MIN_ESTIMATE / 60000),
        max: MAX_MINUTES,
        step: 1,
        inputMode: "numeric",
        placeholder: t("routine.durationOptional"),
        "aria-describedby": "routine-duration-error"
    });
    const durationError = fieldError("routine-duration-error");
    const durationField = field(t("routine.duration"), duration, durationError,
        h("p", { class: "muted small" }, t("routine.durationHint")));

    const target = h("input", {
        type: "number",
        min: 1,
        max: MAX_ROUTINE_TARGET,
        step: 1,
        inputMode: "numeric",
        required: true,
        value: Number.isInteger(routine?.target) ? routine.target : 5,
        "aria-describedby": "routine-target-error"
    });
    const targetError = fieldError("routine-target-error");
    const targetField = field(t("routine.target"), target, targetError);

    const remindBefore = selectControl({
        options: [
            { value: "", label: t("routine.reminderNone") },
            ...ROUTINE_REMINDER_BEFORE.filter(v => v != null).map(v => ({
                value: String(v),
                label: t(REMINDER_BEFORE_LABELS[v])
            }))
        ],
        value: String(routine?.reminderBeforeMs ?? "")
    });
    const remindBeforeField = field(t("routine.reminderBeforeField"), remindBefore.element);

    const remindEvery = selectControl({
        options: [
            { value: "", label: t("routine.reminderNone") },
            ...ROUTINE_REMINDER_EVERY.filter(v => v != null).map(v => ({
                value: String(v),
                label: t(REMINDER_EVERY_LABELS[v])
            }))
        ],
        value: String(routine?.reminderEveryMs ?? "")
    });
    const remindEveryField = field(t("routine.reminderEveryField"), remindEvery.element);

    // Which fields this routine has, from its kind and its frequency. One
    // function, read on every change and again on submit, so what the screen
    // shows and what is sent can never be two different answers.
    const shape = () => ({
        timed: kind.read() === "timed",
        weekly: frequency.select.value === "weekly",
        counter: kind.read() === "counter"
    });

    const paint = () => {
        const { timed, weekly } = shape();
        durationField.hidden = !timed;
        targetField.hidden = timed;
        weekdayField.hidden = !weekly;
        // "Before the day" is what a weekly routine can be reminded about; "every
        // N hours" is what a counter can be nudged on. Neither means anything for
        // the other kind, so neither is offered.
        remindBeforeField.hidden = !weekly;
        remindEveryField.hidden = !shape().counter;
    };
    kind.onChange(paint);
    frequency.select.addEventListener("change", paint);
    paint();

    const save = saveButton();
    const form = formShell([
        kind.node,
        field(t("routine.titleField"), title, titleError),
        frequencyField,
        weekdayField,
        durationField,
        targetField,
        remindBeforeField,
        remindEveryField
    ], save);

    form.addEventListener("submit", async e => {
        e.preventDefault();
        titleError.textContent = "";
        durationError.textContent = "";
        targetError.textContent = "";

        const label = title.value.trim();
        if (!label) {
            titleError.textContent = t("error.required");
            title.focus();
            return;
        }

        const { timed, weekly, counter } = shape();

        // Minutes in, milliseconds out — the same conversion the task estimate
        // does, so a routine and a task of the same length hold the same number.
        let durationMs = null;
        if (timed && duration.value !== "") {
            const minutes = Number(duration.value);
            if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) {
                durationError.textContent = t("error.out_of_range");
                duration.focus();
                return;
            }
            durationMs = minutes * 60000;
        }

        let goal = null;
        if (counter) {
            const value = Number(target.value);
            if (!Number.isInteger(value) || value < 1 || value > MAX_ROUTINE_TARGET) {
                targetError.textContent = t("error.out_of_range");
                target.focus();
                return;
            }
            goal = value;
        }

        save.disabled = true;
        try {
            await onSave({
                kind: kind.read(),
                frequency: frequency.select.value,
                title: label,
                // Every field the shape does not have is sent as null, never as
                // what it still holds — see the note at the top of the file.
                weekday: weekly ? Number(weekday.select.value) : null,
                durationMs,
                target: goal,
                reminderBeforeMs: weekly && remindBefore.select.value !== ""
                    ? Number(remindBefore.select.value)
                    : null,
                reminderEveryMs: counter && remindEvery.select.value !== ""
                    ? Number(remindEvery.select.value)
                    : null
            });
        } finally {
            save.disabled = false;
        }
    });

    return form;
}
