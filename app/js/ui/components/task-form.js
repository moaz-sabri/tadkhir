import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { uiIcon } from "../icons.js";
import { field, fieldError, formShell, saveButton } from "./fields.js";
import { MAX_ESTIMATE, MAX_SUBTASKS } from "../../domain/validation.js";
import {
    toDateTimeInputValue,
    fromDateTimeInputValue
} from "../../domain/time.js";

const MAX_MINUTES = MAX_ESTIMATE / 60000; // 72 * 60 = 4320

export function taskForm(task, onSave) {
    const title = h("input", { required: true, value: task?.title || "", "aria-describedby": "task-title-error", autocomplete: "off" });
    const estimate = h("input", { type: "number", required: true, min: 1, max: MAX_MINUTES, step: 1, inputMode: "numeric", value: Math.round((task?.estimatedMs || 1800000) / 60000), "aria-describedby": "task-estimate-error" });
    // The shared date/time helpers, not toISOString(): a datetime-local control
    // holds local wall-clock, while toISOString() returns UTC. Building the
    // value the other way round showed a 14:00 plan as 12:00 east of Greenwich,
    // and then saved it back shifted by the offset every time the form was
    // opened and saved.
    const plannedAt = h("input", {
        type: "datetime-local",
        value: toDateTimeInputValue(task?.plannedAt)
    });
    const note = h("textarea", { maxLength: 2000 }, task?.note || "");
    const titleError = fieldError("task-title-error");
    const estimateError = fieldError("task-estimate-error");
    const save = saveButton();

    const subtasksBox = h("div", { class: "subtasks-box" });
    const addSubtask = h("button", {
        class: "btn quiet",
        type: "button",
        "aria-label": t("task.addSubtask"),
        title: t("task.addSubtask")
    }, uiIcon("plus", { className: "icon btn-icon" }), t("task.addSubtask"));
    const subtaskHint = h("p", { class: "muted small", role: "status" });
    const subtaskError = fieldError("task-subtasks-error");

    // One subtask per minute of estimate, capped at MAX_SUBTASKS.
    function subtaskLimit() {
        const mins = Number(estimate.value);
        if (!Number.isInteger(mins) || mins < 1) return MAX_SUBTASKS;
        return Math.min(MAX_SUBTASKS, mins);
    }

    function countedRows() {
        return [...subtasksBox.querySelectorAll(".subtask-row input[type='text']")]
            .filter(input => input.value.trim());
    }

    function refreshSubtaskGate() {
        const limit = subtaskLimit();
        const count = countedRows().length;
        addSubtask.disabled = count >= limit;
        subtaskError.textContent = "";
        subtaskHint.textContent = t("task.subtaskLimitHint", { count: limit });
    }

    // A subtask row is the same shape as a checklist row on the running session —
    // one field and one remove control — because they are the same thing: an
    // item on a list that the user can tick off and remove.
    function subtaskRow(item) {
        const input = h("input", {
            type: "text",
            maxLength: 120,
            placeholder: t("task.subtaskPlaceholder"),
            "aria-label": t("task.subtaskPlaceholder"),
            value: item.title,
            dataset: { id: item.id },
            onInput: refreshSubtaskGate
        });
        const remove = h("button", {
            type: "button",
            class: "check-remove",
            "aria-label": t("task.removeSubtask"),
            title: t("task.removeSubtask"),
            onClick: () => { row.remove(); refreshSubtaskGate(); }
        }, uiIcon("close", { className: "icon icon-sm" }));
        const row = h("div", { class: "check-row subtask-row" }, input, remove);
        return row;
    }

    function renderSubtasks(items) {
        subtasksBox.replaceChildren(...items.map(item => subtaskRow(item)));
        subtasksBox.append(subtaskRow({ id: crypto.randomUUID(), title: "" }));
        refreshSubtaskGate();
    }

    addSubtask.addEventListener("click", () => {
        if (countedRows().length >= subtaskLimit()) return;
        subtasksBox.append(subtaskRow({ id: crypto.randomUUID(), title: "" }));
        refreshSubtaskGate();
    });
    estimate.addEventListener("input", refreshSubtaskGate);
    renderSubtasks((task?.subtasks || []).map(s => ({ id: s.id, title: s.title })));

    const form = formShell([
        field(t("task.title"), title, titleError),
        field(t("task.estimate"), estimate, estimateError),
        field(t("task.plannedAt"), plannedAt),
        field(t("task.note"), note),
        h("div", { class: "field-group" },
            h("h3", { class: "check-head" }, t("task.subtasks")),
            subtasksBox,
            h("div", { class: "form-actions" }, addSubtask),
            subtaskHint,
            subtaskError
        )
    ], save);

    form.addEventListener("submit", async e => {
        e.preventDefault();
        titleError.textContent = "";
        estimateError.textContent = "";
        subtaskError.textContent = "";

        if (!title.value.trim()) {
            titleError.textContent = t("error.required");
            title.focus();
            return;
        }

        const minutes = Number(estimate.value);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) {
            estimateError.textContent = t("error.out_of_range");
            estimate.focus();
            return;
        }

        const subtasks = [];
        for (const row of subtasksBox.querySelectorAll(".subtask-row")) {
            const input = row.querySelector("input[type='text']");
            const value = input?.value?.trim();
            if (!value) continue;
            subtasks.push({ id: input.dataset.id || crypto.randomUUID(), title: value });
        }
        if (subtasks.length > subtaskLimit()) {
            subtaskError.textContent = t("error.too_many_subtasks");
            return;
        }

        save.disabled = true;
        try {
            // Read with the same helper that wrote the value, so a plan made at
            // 14:00 stays at 14:00 whatever the device's UTC offset is.
            const plannedAtValue = plannedAt.value ? fromDateTimeInputValue(plannedAt.value) : null;
            await onSave({ title: title.value, estimatedMs: minutes * 60000, note: note.value, plannedAt: plannedAtValue, subtasks });
        } finally {
            save.disabled = false;
        }
    });

    return form;
}
