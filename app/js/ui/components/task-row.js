import { t } from "../../i18n/i18n.js";
import { formatDate } from "../../domain/time.js";
import { listRow, rowAction, badge } from "./ui.js";

// One task in a list.
//
// Every action on this row is an icon, not a word. The row used to carry four
// text buttons plus a count; in Arabic the words are wider, the row's own title
// ended up sharing a line with its own controls, and the count was an orphan
// number nobody could interpret. Four square icon controls take a fixed 176px
// whatever the language, so the title gets the rest of the row and the count
// becomes a labelled figure beside it. The words are still there — as each
// button's accessible name and its tooltip.
//
// The callbacks come in one object rather than as five positional arguments,
// because a fifth and sixth of them arrived with the Kanban board and a row like
// `taskRow(x, f, g, h, i, j)` is a row where swapping two of them is a silent
// bug rather than a syntax error. Named keys are checked by the reader, not by
// the parser. The shape matches `laterRow`, so the two lists are written the
// same way.
export function taskRow(task, {
    onStart = null,
    onTogglePin = null,
    onArchive = null,
    onDelete = null,
    // Passed only for a task that is NOT already on the board, and never for an
    // archived one: the board offers nothing for work that is out of sight, and a
    // card pointing at an archived task is a card whose original is not on the
    // list any more.
    onAddToBoard = null
} = {}) {
    return listRow({
        href: `/tasks/${task.id}`,
        title: task.title,
        meta: [
            // The count is a figure, so it is a badge with a name on it rather
            // than a bare number at the end of the row.
            task.usageCount > 0
                ? badge(`${t("task.stats.sessions")}: ${task.usageCount}`, { icon: "history" })
                : null,
            // A task planned for a day says so here, which is the same fact the
            // card shows as its due date. Without it a task scheduled for next
            // Tuesday looks identical to one scheduled for next year, and the
            // board is where the difference matters.
            Number.isInteger(task.plannedAt)
                ? badge(formatDate(task.plannedAt), { icon: "calendar" })
                : null
        ].filter(Boolean),
        actions: [
            onStart
                ? rowAction({ label: t("task.start"), icon: "play", tone: "primary", onClick: onStart })
                : null,
            onTogglePin
                ? rowAction({
                    label: task.pinned ? t("task.unpin") : t("task.pin"),
                    icon: "pin",
                    onClick: onTogglePin
                })
                : null,
            onArchive
                ? rowAction({
                    label: task.archived ? t("task.restore") : t("task.archive"),
                    icon: task.archived ? "undo" : "archive",
                    onClick: onArchive
                })
                : null,
            onAddToBoard
                ? rowAction({ label: t("kanban.addToBoard"), icon: "kanban", onClick: onAddToBoard })
                : null,
            onDelete
                ? rowAction({ label: t("task.delete"), icon: "trash", onClick: onDelete })
                : null
        ].filter(Boolean)
    });
}
