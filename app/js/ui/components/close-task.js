import { taskService } from "../../services/task-service.js";
import { dialog } from "./dialog.js";
import { toast } from "./toast.js";

// "Close this task" is archive-then-offer-delete, in ONE dialog chain.
//
// Archiving is the reversible action and is what "closing" means: the task
// leaves the list but its history (sessions, reports) is untouched. The second
// question is asked only after the archive succeeded, and both of its answers
// render into the same #dialog-root, so it reads as one flow rather than two
// unrelated prompts. This matters most for throwaway items — a task typed to
// start a single session — where archiving leaves clutter the user then has to
// hunt for later.
//
// Returns the action actually taken: "archived", "deleted", or "cancelled".
export async function closeTask(task) {
    // Confirm and archive in one step. A failed archive must not lead to a
    // delete question about a task that is still open.
    if (!await dialog.confirm("task.closeConfirm")) return "cancelled";

    try {
        await taskService.archive(task.id);
    } catch (e) {
        toast.show(`error.${e?.code || "unexpected"}`);
        return "cancelled";
    }

    const choice = await dialog.choose("task.afterClose", [
        // "Keep" is the safe outcome and is the one the dialog focuses, so Enter
        // keeps rather than deletes. Deleting is a second tap, on the button
        // marked as destructive.
        { label: "task.keep", value: "keep", class: "primary" },
        { label: "task.deleteNow", value: "delete", class: "danger" }
    ]);

    if (choice !== "delete") return "archived";

    try {
        await taskService.remove(task.id);
        return "deleted";
    } catch (e) {
        // The archive already succeeded, so the task is safely out of the way.
        // A delete failure (e.g. a session is still running on it) is reported
        // but is not a reason to undo the archive.
        toast.show(`error.${e?.code || "unexpected"}`);
        return "archived";
    }
}
