import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { categoryService } from "../../services/category-service.js";
import { financeCategoryForm } from "../components/finance-category-form.js";
import { financeNav } from "../components/finance-nav.js";
import { categoryLabel } from "../components/finance-fields.js";
import { DEFAULT_FINANCE_CATEGORY } from "../../domain/validation.js";
import { dialog } from "../components/dialog.js";
import { toast } from "../components/toast.js";
import { router } from "../../app/router.js";
import {
    page,
    pageHead,
    list,
    listRow,
    rowAction,
    emptyState,
    badge,
    action
} from "../components/ui.js";

const BASE = "/finance/categories";

// A category is only its name, so this screen has no forms beyond a single
// text field. What it does have to get right is deletion: a category can have
// transactions, rules and debts attached, and silently filing them under
// "Other" (or dropping them) is a decision this screen must not make on the
// user's behalf — so it asks, and it says how many records are involved first.
export const financeCategoriesPage = {
    title: () => t("finance.categoriesPage"),

    async mount(root) {
        // One read pass for the list plus every usage count, so the numbers on
        // screen are the real ones rather than a guess made per row later.
        const categories = await categoryService.listWithUsage();

        const body = categories.length === 0
            ? emptyState(t("finance.addCategoryHint"), {
                icon: "tag",
                action: action({ label: t("finance.addCategory"), icon: "plus", tone: "primary", onClick: () => this.openForm() })
            })
            : list(...categories.map(c => this.renderRow(c)));

        root.append(page(
            pageHead({
                title: t("finance.categoriesPage"),
                icon: "tag",
                // The "add" control is a button here, not a link, because it opens
                // a dialog rather than a page. Same header slot as every other
                // screen's "new" control, whichever kind it happens to be.
                actions: action({ label: t("finance.addCategory"), icon: "plus", tone: "primary", onClick: () => this.openForm() })
            }),
            financeNav(BASE),
            h("p", { class: "muted" }, t("finance.categoriesPageHint")),
            body
        ));
    },

    renderRow(cat) {
        const isDefault = cat.id === DEFAULT_FINANCE_CATEGORY;
        const { total, transactions, recurring, debts } = cat.usage;

        return listRow({
            icon: "tag",
            title: categoryLabel(cat.id),
            titleClass: "bold",
            subtitle: total > 0
                ? t("finance.usedIn", { count: total, transactions, recurring, debts })
                : null,
            actions: isDefault
                ? [badge(t("finance.categoryDefault"), { icon: "lock" })]
                : [
                    rowAction({ label: t("finance.renameCategory"), icon: "pencil", onClick: () => this.openForm(cat) }),
                    rowAction({ label: t("common.delete"), icon: "trash", onClick: () => this.remove(cat, total) })
                ]
        });
    },

    async openForm(existing = null) {
        const value = await financeCategoryForm(existing);
        if (!value) return;
        try {
            if (existing) await categoryService.rename(existing.id, value.id);
            else await categoryService.create(value);
            router.refresh();
        } catch (e) {
            // The toast is for the user; the console keeps the real cause. A
            // bare "something went wrong" with nothing logged anywhere is what
            // made this failure hard to track down in the first place.
            console.error("category save failed", e);
            toast.show(`error.${e?.code || "unexpected"}`);
        }
    },

    async remove(cat, total) {
        if (total === 0) {
            if (await dialog.confirm("finance.deleteCategoryConfirm")) {
                await this.doRemove(cat.id, "delete");
            }
            return;
        }
        // Linked records exist, so there are two real answers and no safe
        // default: move them to the default category, or remove them. "Keep the
        // records" is the safe one and is what the dialog focuses; deleting them
        // is a second tap on the button marked destructive.
        const choice = await dialog.choose("finance.deleteCategoryWithRecords", [
            { label: "finance.moveToDefault", value: "move", class: "primary", icon: "folder" },
            { label: "finance.deleteRecords", value: "delete", class: "danger", icon: "trash" }
        ]);
        // Compared against the dismissal sentinel rather than tested for
        // truthiness: a dismissed dialog resolves with a symbol, and "if
        // (choice)" would have gone ahead and deleted things.
        if (choice === "move" || choice === "delete") await this.doRemove(cat.id, choice);
    },

    async doRemove(id, strategy) {
        try {
            await categoryService.remove(id, strategy);
            router.refresh();
        } catch (e) {
            console.error("category delete failed", e);
            toast.show(`error.${e?.code || "unexpected"}`);
        }
    }
};
