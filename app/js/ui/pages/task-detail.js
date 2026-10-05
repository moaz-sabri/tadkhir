import { t } from "../../i18n/i18n.js";
import { store } from "../../app/store.js";
import { router } from "../../app/router.js";
import { taskService } from "../../services/task-service.js";
import { sessionService } from "../../services/session-service.js";
import { taskForm } from "../components/task-form.js";
import { dialog } from "../components/dialog.js";
import { toast } from "../components/toast.js";
import { formatShort, dayLabel } from "../../domain/time.js";
import {
    page,
    pageHead,
    pageSection,
    statPanel,
    stat,
    toolbar,
    action,
    backTo,
    notFoundView
} from "../components/ui.js";

export const taskDetail = {
    title: () => t("task.edit"),
    async mount(root, params) {
        const task = store.getState().tasks.find(x => x.id === params.id);
        // One not-found screen for the whole app, so a record that is gone reads
        // the same way wherever it was opened from.
        if (!task) {
            notFoundView(root);
            return;
        }

        root.append(page(
            pageHead({
                title: task.title,
                icon: "tasks",
                leading: backTo("/tasks")
            }),
            // The same figure cells the Finance and Reports screens report in.
            // A task used to print "Sessions: 4" as a loose grey sentence in a
            // strip, which is the one place in the app a number was not a stat.
            statPanel(
                stat({ label: t("task.estimate"), value: formatShort(task.estimatedMs), icon: "target" }),
                stat({ label: t("task.stats.sessions"), value: task.usageCount ?? 0, icon: "history" }),
                // The two relative words are passed in rather than hardcoded in
                // the time module, so the same rule reads as اليوم/أمس in Arabic
                // and TODAY/YESTERDAY in English — and anything older comes back
                // as a date formatted for the reader's locale, not a raw key.
                stat({
                    label: t("task.stats.lastUsed"),
                    value: task.lastUsedAt
                        ? dayLabel(task.lastUsedAt, Date.now(), {
                            today: t("time.today"),
                            yesterday: t("time.yesterday")
                        })
                        : "—",
                    icon: "calendar"
                })
            ),
            toolbar(
                action({
                    label: t("task.start"),
                    icon: "play",
                    tone: "primary",
                    onClick: async () => {
                        try { await sessionService.start(task.id); await store.refresh("all"); router.navigate("/session"); }
                        catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
                    }
                }),
                action({
                    label: task.pinned ? t("task.unpin") : t("task.pin"),
                    icon: "pin",
                    onClick: async () => {
                        try { await taskService.togglePin(task.id); await store.refresh("all"); router.refresh(); }
                        catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
                    }
                }),
                action({
                    label: task.archived ? t("task.restore") : t("task.archive"),
                    icon: task.archived ? "undo" : "archive",
                    onClick: async () => {
                        try { await taskService[task.archived ? "restore" : "archive"](task.id); await store.refresh("all"); router.navigate("/tasks"); }
                        catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
                    }
                }),
                action({
                    label: t("task.delete"),
                    icon: "trash",
                    tone: "danger",
                    onClick: async () => {
                        if (await dialog.confirm("task.deleteConfirm")) {
                            try { await taskService.remove(task.id); await store.refresh("all"); router.navigate("/tasks"); }
                            catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
                        }
                    }
                })
            ),
            pageSection({
                body: taskForm(task, async patch => {
                    try { await taskService.update(task.id, patch); await store.refresh("all"); router.refresh(); }
                    catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
                })
            })
        ));
    }
};
