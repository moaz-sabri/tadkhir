import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { dialog } from "./dialog.js";
import { field, fieldError } from "./fields.js";
import { MAX_TITLE } from "../../domain/validation.js";

// Add or rename one category. A category IS its name, so this is a single
// text field: there is nothing else about a category to set.
//
// Resolves to { id } to save, or to dialog.CANCELLED if dismissed. The caller
// performs the write, so a duplicate or a rejected name surfaces as a toast on
// the page rather than as an error inside a dialog that already closed.
//
// This used to build its own `.dialog-backdrop` / `.dialog` pair and its own
// Enter and Escape handlers — a third copy of the one modal in the app, and one
// lifecycle too many: it ignored a navigation, so it stayed on screen over the
// page that had replaced it, and it resolved with a bare `null`, so a dismissal
// was indistinguishable from a legitimate answer and the caller had to wrap it.
// It is an ordinary dialog.form now — the same one the settings prompts use —
// with the field built from the shared field kit, so its caption and its error
// line are the same as every other form's.
export function financeCategoryForm(existing = null) {
    const isRename = Boolean(existing);
    // Set by `body`, read by `submit`. Both are the one validation, so the
    // button and the Enter key cannot disagree about what is acceptable.
    let accept = () => {};

    return dialog.form(
        t(isRename ? "finance.renameCategoryHint" : "finance.addCategoryHint"),
        {
            titleKey: isRename ? "finance.renameCategory" : "finance.addCategory",
            submitLabel: isRename ? "finance.renameCategory" : "finance.addCategory",
            submitIcon: "check",
            body: close => {
                const errorId = "fin-category-error";
                const input = h("input", {
                    type: "text",
                    maxLength: MAX_TITLE,
                    value: existing?.id || "",
                    placeholder: t("finance.categoryPlaceholder"),
                    autocomplete: "off",
                    "aria-describedby": errorId
                });
                const error = fieldError(errorId);
                // A failed check leaves the dialog open with the reason under the
                // field, instead of closing and taking the typed name with it.
                accept = () => {
                    const value = input.value.trim();
                    if (!value) {
                        error.textContent = t("error.required");
                        input.focus();
                        return;
                    }
                    close({ id: value });
                };
                input.addEventListener("input", () => { error.textContent = ""; });
                input.addEventListener("keydown", e => {
                    if (e.key === "Enter") { e.preventDefault(); accept(); }
                });
                return field(t("finance.categoryField"), input, error);
            },
            submit: () => accept()
        }
    ).then(value => (value === dialog.CANCELLED ? null : value));
}
