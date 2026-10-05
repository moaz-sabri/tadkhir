import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { store } from "../../app/store.js";
import { router } from "../../app/router.js";
import { taskService } from "../../services/task-service.js";
import { sessionService } from "../../services/session-service.js";
import { taskForm } from "../components/task-form.js";
import { taskRow } from "../components/task-row.js";
import { kanbanService } from "../../services/kanban-service.js";
import { haptics } from "../../app/haptics.js";
import { toast } from "../components/toast.js";
import { dialog } from "../components/dialog.js";
import { page, pageHead, list, emptyState, action, backTo as backLink } from "../components/ui.js";
import { searchField } from "../components/fields.js";

export const tasksPage = {
    title: () => t("nav.tasks"),
    async mount(root) {
        const { element: search, input: query } = searchField(t("task.searchPlaceholder"));
        const listBox = h("div", { class: "list" });

        root.append(page(
            pageHead({
                title: t("nav.tasks"),
                icon: "tasks",
                actions: action({ label: t("task.new"), icon: "plus", tone: "primary", href: "/tasks/new" })
            }),
            search,
            listBox
        ));

        // Which tasks are already on the board, read once per render rather than
        // once per row. The board is one store, so asking it per row would open
        // one transaction per task to learn one fact. It is a promise rather than
        // a value because `render()` is synchronous and this is not — the answer
        // arrives, and the rows are drawn again with it. A row drawn before the
        // answer simply offers the button, and the second render takes it away.
        let onBoard = new Set();
        let boardRead = 0;

        const refreshBoardFlags = async rows => {
            const run = ++boardRead;
            const answers = await Promise.all(rows.map(x =>
                kanbanService.has(`tasks:${x.id}`).then(yes => (yes ? x.id : null), () => null)
            ));
            // A render that started while this one was in flight must not write
            // over the newer answer.
            if (run !== boardRead) return;
            onBoard = new Set(answers.filter(Boolean));
        };

        // Puts one task on the board. The task is not copied and not changed: a
        // card is a pointer, and it reads its label from this record whenever the
        // board is drawn.
        const addToBoard = async x => {
            try {
                await kanbanService.addFromOriginal(x, { service: "tasks", dueAt: x.plannedAt ?? null });
                haptics.do("ack");
                toast.show("kanban.added");
            } catch (e) {
                toast.show(`error.${e?.code || "unexpected"}`);
            }
            await refreshBoardFlags(store.getState().tasks.filter(t2 => !t2.archived));
            render();
        };

        const render = () => {
            const q = query.value.trim().toLowerCase();
            const all = store.getState().tasks.filter(x => !x.archived);
            const rows = q
                ? all.filter(x => `${x.title} ${x.note ?? ""}`.toLowerCase().includes(q))
                : all;

            void refreshBoardFlags(rows);

            if (rows.length === 0) {
                listBox.replaceChildren(emptyState(t("task.noResults"), {
                    icon: "tasks",
                    action: action({ label: t("task.new"), icon: "plus", tone: "primary", href: "/tasks/new" })
                }));
                return;
            }

            listBox.replaceChildren(list(...rows.map(x => taskRow(x, {
                onStart: async () => {
                    try { await sessionService.start(x.id); await store.refresh("all"); router.navigate("/session"); }
                    catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
                },
                onTogglePin: async () => {
                    try { await taskService.togglePin(x.id); await store.refresh("all"); router.refresh(); }
                    catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
                },
                onArchive: async () => {
                    try { await taskService[x.archived ? "restore" : "archive"](x.id); await store.refresh("all"); router.navigate("/tasks"); }
                    catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
                },
                onDelete: async () => {
                    if (await dialog.confirm("task.deleteConfirm")) {
                        // taskService.remove also takes the board's card off, so
                        // deleting a task cannot leave a card pointing at nothing.
                        try { await taskService.remove(x.id); await store.refresh("all"); router.navigate("/tasks"); }
                        catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
                    }
                },
                onAddToBoard: onBoard.has(x.id) ? null : () => addToBoard(x)
            }))));
        };

        query.addEventListener("input", render);
        render();
    }
};

export const newTask = {
    title: () => t("task.new"),
    mount(root) {
        // A "new" screen gets the same header as every other one, with the way
        // back out in the same slot. It used to be a bare heading with no way out
        // at all except the destinations, which on a form that fills the screen
        // is not a way out.
        root.append(page(
            pageHead({
                title: t("task.new"),
                icon: "plus",
                leading: backLink("/tasks")
            }),
            taskForm(null, async x => {
                try { await taskService.create(x); await store.refresh("all"); router.navigate("/tasks"); }
                catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
            })
        ));
    }
};
