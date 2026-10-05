import { t } from "../../i18n/i18n.js";
import { formatShort } from "../../domain/time.js";
import { listRow, rowAction, badge } from "./ui.js";

// One routine, drawn. Shared by the home screen's "today" list and by the list
// screen, because a counter that reads "3 / 5" on one screen and something else
// on another is two truths about the same row — and it is the row every user of
// this feature will read most often.
//
// The two kinds differ in exactly what they offer, and both differences are the
// feature rather than styling:
//
//   timed    one action, "Start", and it starts the app's own timer. The length
//            is a badge because it is a fact about the rule, not a state.
//   counter  two actions, and a ratio. No session, no task, nothing to start —
//            pressing "+" IS the whole interaction, which is why a counter does
//            not put an hourglass on its row.
//
// A routine that is done today says so with a check and stops offering to start
// again: the timer allows one session at a time, and a second run of the same
// routine in a day is not something the feature invents a use for. The counter's
// buttons stay, because going back down is the user's own correction and hiding
// it would be hiding the only undo there is.
//
// Nothing on this row refers to any other day. There is no overdue state, no
// streak and no percentage, and a rule that was not repeated yesterday produces
// no row here at all — the list it appears in is built from today.
export function routineRow(view, { onStart, onBump } = {}) {
    const routine = view.routine;
    const meta = [];

    if (routine.kind === "counter") {
        meta.push(badge(counterRatio(view.count, view.target), { icon: "target" }));
    } else if (routine.durationMs) {
        meta.push(badge(formatShort(routine.durationMs), { icon: "clock" }));
    }

    if (view.done) meta.push(badge(t("routine.done"), { icon: "check" }));
    if (routine.reminderBeforeMs) meta.push(badge(t("routine.remindBefore", { hours: hoursOf(routine.reminderBeforeMs) })));
    if (routine.reminderEveryMs) meta.push(badge(t("routine.remindEvery", { hours: hoursOf(routine.reminderEveryMs) })));

    const actions = routine.kind === "counter"
        ? [
            rowAction({
                label: t("routine.decrease"),
                icon: "minus",
                // Never disabled at zero for a reason the user cannot see: it is
                // disabled because there is nothing to take away, and the count on
                // the row says so.
                disabled: (view.count ?? 0) <= 0,
                onClick: () => onBump?.(routine.id, -1)
            }),
            rowAction({
                label: t("routine.increase"),
                icon: "plus",
                onClick: () => onBump?.(routine.id, 1)
            })
        ]
        : view.done
            ? []
            : [rowAction({
                label: t("routine.start"),
                icon: "play",
                tone: "primary",
                onClick: () => onStart?.(routine.id)
            })];

    return listRow({
        href: `/routines/${routine.id}`,
        icon: routine.kind === "counter" ? "target" : "clock",
        title: routine.title,
        subtitle: routineSubtitle(routine),
        meta,
        actions
    });
}

// `3 / 5`. Written out rather than formatted: it is two numbers and a slash, it
// has no noun to agree with in either language, and the digits are already the
// ones the counter is stored in.
export function counterRatio(count, target) {
    return `${count ?? 0} / ${target ?? 0}`;
}

// The second line of a row: WHEN it comes up, and nothing about whether it was
// kept. "Every day" and "Every Friday" are the whole schedule a routine has.
function routineSubtitle(routine) {
    return routine.frequency === "weekly"
        ? t("routine.everyWeekday", { day: t(`weekday.${routine.weekday}`) })
        : t("routine.everyDay");
}

// Hours, for the reminder badges. The lists these are chosen from are whole hours
// (see ROUTINE_REMINDER_BEFORE / _EVERY), so the division is exact; the floor is
// a guard against a record written by a future version with a value this one
// cannot render, and it would rather say "0" than say NaN.
function hoursOf(ms) {
    return Math.max(0, Math.floor(ms / 3600000));
}
