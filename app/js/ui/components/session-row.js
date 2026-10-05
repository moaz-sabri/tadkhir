import { t } from "../../i18n/i18n.js";
import { formatShort } from "../../domain/time.js";
import { listRow, badge } from "./ui.js";

// One session in a list.
//
// The two figures a reader wants off this row — how long, and what happened to
// it — are badges, like every other fact on every other row, so a session list
// reads the same way as a task list or a Later list.
export function sessionRow(session) {
    const actual = session.actualMs ?? session.segments.reduce((sum, x) => sum + Math.max(0, (x.end ?? Date.now()) - x.start), 0);
    const running = ["running", "paused"].includes(session.status);
    return listRow({
        href: `/sessions/${session.id}`,
        title: session.taskTitle || t("session.free"),
        meta: [
            badge(t(`session.${session.status}`), { icon: running ? "clock" : "check" }),
            badge(formatShort(actual), { icon: "target" })
        ]
    });
}
