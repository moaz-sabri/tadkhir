import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { router } from "../../app/router.js";
import { sessionService } from "../../services/session-service.js";
import { formatShort, formatClock } from "../../domain/time.js";
import { MAX_DURATION_MS, MAX_NOTE } from "../../domain/validation.js";
import { dialog } from "../components/dialog.js";
import { toast } from "../components/toast.js";
import { uiIcon } from "../icons.js";
import {
    page,
    pageHead,
    pageSection,
    statPanel,
    stat,
    toolbar,
    action,
    backTo,
    notFoundView,
    list
} from "../components/ui.js";

export const sessionDetail = {
    title: () => t("nav.sessions"),
    async mount(root, params) {
        const s = await sessionService.get(params.id);
        if (!s) {
            notFoundView(root);
            return;
        }
        const ev = await sessionService.events(s.id);
        const actual = s.actualMs ?? Math.min(MAX_DURATION_MS, s.segments.reduce((sum, x) => sum + Math.max(0, (x.end ?? Date.now()) - x.start), 0));
        const overtime = s.estimatedMs ? actual - s.estimatedMs : 0;

        // The figures a session is judged by, as the same stat cells every other
        // screen reports in — elapsed, the estimate, and the difference between
        // them. It used to be two loose sentences, one of which was a bare number
        // with no label at all.
        const figures = [
            stat({ label: t("session.elapsed"), value: formatShort(actual), icon: "clock" }),
            s.estimatedMs
                ? stat({ label: t("session.estimated"), value: formatShort(s.estimatedMs), icon: "target" })
                : null,
            overtime > 0
                ? stat({ label: t("session.over"), value: formatClock(overtime), icon: "warning" })
                : (overtime < 0 && ["completed", "cancelled"].includes(s.status)
                    ? stat({ label: t("session.under"), value: formatClock(-overtime), icon: "check" })
                    : null)
        ].filter(Boolean);

        root.append(page(
            pageHead({
                title: s.taskTitle || t("session.free"),
                icon: "clock",
                leading: backTo("/sessions")
            }),
            statPanel(...figures),

            // The checklist. It used to be a list of rows with a literal "✓" and
            // "○" glyph in place of the checkbox, styled as a different component
            // from the identical checklist on the running session. It is the same
            // shape now, with a real checkbox and the same tick icon.
            (s.taskItems && s.taskItems.length > 0)
                ? pageSection({
                    title: t("session.checklist"),
                    icon: "tasks",
                    body: list(...s.taskItems.map(it => h("div", { class: `check-row ${it.completed ? "done" : ""}`.trim() },
                        h("span", { class: "check-glyph" },
                            uiIcon(it.completed ? "check" : "minus", { className: "icon icon-sm" })
                        ),
                        h("span", { class: "check-title" }, it.title),
                        h("span", { class: "muted small" },
                            t(it.completed ? "session.taskCompleted" : "session.taskUncompleted"))
                    )))
                })
                : null,

            // Session journal: editable on the detail page too, saved with the
            // session record via saveNote(id, ...).
            pageSection({
                title: t("session.note"),
                icon: "note",
                body: (() => {
                    const noteInput = h("textarea", {
                        maxLength: MAX_NOTE,
                        rows: 4,
                        placeholder: t("session.notePlaceholder"),
                        "aria-label": t("session.notePlaceholder")
                    });
                    noteInput.value = s.note ?? "";
                    const noteSave = action({
                        label: t("session.saveNote"),
                        icon: "check",
                        onClick: async () => {
                            noteSave.disabled = true;
                            try {
                                const updated = await sessionService.saveNote(s.id, noteInput.value);
                                noteInput.value = updated.note ?? "";
                                toast.show("session.noteSaved");
                            } catch (e) {
                                toast.show(`error.${e?.code || "unexpected"}`);
                            } finally {
                                noteSave.disabled = false;
                            }
                        }
                    });
                    return h("div", { class: "field" }, noteInput, h("div", { class: "form-actions" }, noteSave));
                })()
            }),

            pageSection({
                title: t("session.timeline"),
                icon: "history",
                body: h("div", { class: "timeline" },
                    ...s.segments.map(seg => {
                        const dur = (seg.end ?? Date.now()) - seg.start;
                        return h("div", { class: "timeline-row" },
                            h("span", { class: "number" }, new Date(seg.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
                            h("span", {}, t("session.started") + " " + formatClock(dur))
                        );
                    }),
                    ...ev.sort((a, b) => a.at - b.at).map(e => h("div", { class: "timeline-row" },
                        h("span", { class: "number" }, new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
                        h("span", {}, eventLabel(s, e))
                    ))
                )
            }),

            toolbar(
                s.taskId
                    ? action({
                        label: t("session.restart"),
                        icon: "play",
                        tone: "primary",
                        onClick: async () => {
                            try { await sessionService.start(s.taskId); router.navigate("/session"); }
                            catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
                        }
                    })
                    : null,
                action({
                    label: t("common.delete"),
                    icon: "trash",
                    tone: "danger",
                    onClick: async () => {
                        if (await dialog.confirm("session.deleteConfirm")) {
                            try { await sessionService.remove(s.id); router.navigate("/sessions"); }
                            catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
                        }
                    }
                })
            )
        ));
    }
};

// Maps a persisted event type to its translated timeline line. Task completion
// events pull the title from the session's taskItems snapshot (never from the
// live Task) and keep reading correctly even if the task was deleted later.
function eventLabel(s, e) {
    if (e.type === "session.task.completed" || e.type === "session.task.uncompleted") {
        const item = (s.taskItems || []).find(x => x.id === e.data?.taskId);
        const key = e.type === "session.task.completed"
            ? "session.event.taskCompleted"
            : "session.event.taskUncompleted";
        return t(key, { task: item?.title || e.data?.taskId || t("session.free") });
    }
    if (e.type === "session.item.added" || e.type === "session.item.removed") {
        const key = e.type === "session.item.added"
            ? "session.event.itemAdded"
            : "session.event.itemRemoved";
        const title = e.type === "session.item.added" ? e.data?.item?.title : e.data?.title;
        return t(key, { item: title || e.data?.itemId || t("session.free") });
    }
    return t(`session.event.${e.type.split(".")[1]}`);
}
