import { withTx } from "../data/db.js";
import { reader, guardQuota } from "../data/stores.js";
import { validateTaskInput } from "../domain/validation.js";
import { TaskBusyError, NotFoundError } from "../domain/errors.js";
import { bus } from "../app/bus.js";
import { broadcastChange } from "../app/sync.js";
import { syncService } from "./sync-service.js";

const tasks = reader("task");
const sessions = reader("session");
const T_TASK = "task";

const now = () => Date.now();

function notify() {
    bus.emit("data-changed");
    broadcastChange();
}

export const taskService = {
    async list() {
        return withTx(["tasks"], "readonly", r => tasks(r).getAll());
    },

    // One task by id, or NotFound. Every other record service answers this, and
    // a caller holding an id — a board card pointing at a task, a detail screen
    // opened from a stale bookmark — should not have to know that `list` and then
    // filter. Throwing rather than returning null is the point: "no such task" and
    // "the read failed" must not look alike to a caller about to open a screen.
    async get(id) {
        const task = await withTx(["tasks"], "readonly", r => tasks(r).get(id));
        if (!task) throw new NotFoundError("task", id);
        return task;
    },

    async create(input) {
        const at = now();
        const x = validateTaskInput(input);
        const task = {
            id: crypto.randomUUID(),
            ...x,
            pinned: false,
            archived: false,
            // When it was closed, and null while it is open. The Log dates a
            // finished task by this and not by `updatedAt`, which moves every time
            // the task is edited — so a task finished in March and renamed in May
            // would be reported as finished in May. A field is cheap; a wrong date
            // in a history is not.
            archivedAt: null,
            usageCount: 0,
            lastUsedAt: null,
            createdAt: at,
            updatedAt: at
        };
        await withTx(["tasks"], "readwrite", async r => {
            await guardQuota(r, T_TASK);
            await tasks(r).put(task);
        });
        await syncService.enqueue(T_TASK, task.id, "upsert", task);
        notify();
        return task;
    },

    async update(id, patch) {
        const task = await withTx(["tasks"], "readonly", r => tasks(r).get(id));
        if (!task) throw new NotFoundError("task", id);
        const merged = validateTaskInput({ ...task, ...patch });
        const next = { ...task, ...merged, updatedAt: now() };
        await withTx(["tasks"], "readwrite", r => tasks(r).put(next));
        await syncService.enqueue(T_TASK, id, "upsert", next);
        notify();
        return next;
    },

    async togglePin(id) {
        const current = (await this.list()).find(x => x.id === id)?.pinned ?? false;
        return this.update(id, { pinned: !current });
    },

    // Archiving and restoring both write the stamp, in opposite directions. It is
    // set here rather than derived from `updatedAt` because a task that is
    // un-archived and archived again is closed twice, and only the second closing
    // is a day the Log can honestly report.
    async archive(id) {
        return this.update(id, { archived: true, archivedAt: now() });
    },

    async restore(id) {
        return this.update(id, { archived: false, archivedAt: null });
    },

    async remove(id) {
        const active = await withTx(["sessions"], "readonly", r => sessions(r).getActive());
        if (active?.taskId === id) throw new TaskBusyError(id);
        await withTx(["tasks"], "readwrite", r => tasks(r).delete(id));
        await syncService.enqueue(T_TASK, id, "delete", null, now());
        notify();
        // Announced so the board can drop the card that pointed here. A card whose
        // task is gone is a card nobody can open, so the board must not be left
        // holding one. Archiving does NOT announce: the task still exists, and a
        // board card pointing at an archived task is a card that still opens.
        bus.emit("record-deleted", { service: "tasks", id });
    }
};