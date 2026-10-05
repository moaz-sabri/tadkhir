import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { router } from "../../app/router.js";
import { pageService } from "../../services/page-service.js";
import { pageLabel } from "../../domain/pages.js";
import { MAX_TITLE, MAX_NOTE, PAGE_ITEM_TARGETS } from "../../domain/validation.js";
import { toast } from "../components/toast.js";
import { dialog } from "../components/dialog.js";
import { pageItemNode } from "../components/page-item.js";
import { markdownEditor } from "../components/markdown-editor.js";
import { onFlush } from "../../app/flush.js";
import { resolveAll } from "../components/page-records.js";
import { choosePageItemKind, chooseRecord } from "../components/page-picker.js";
import { kanbanService } from "../../services/kanban-service.js";
import { haptics } from "../../app/haptics.js";
import { formatDate } from "../../domain/time.js";
import {
    page,
    pageHead,
    pageSection,
    list,
    listRow,
    rowAction,
    emptyState,
    action,
    backTo,
    toolbar,
    badge,
    notFoundView
} from "../components/ui.js";
import { field } from "../components/fields.js";

const BASE = "/pages";

// How long after the last keystroke the page's own title and description are
// saved. The same debounce the item lines use, and for the same reason: one write
// per pause in typing rather than one per letter.
const AUTOSAVE_MS = 500;

// The list of pages: the one place a page is created from inside the app.
//
// "New page" writes an UNTITLED page and goes straight to it, rather than asking
// for a title first. A page is a thing you fill in, not a thing you name in one
// field, and a title prompt before it exists would mean a second screen and a
// Cancel that has to clean up after itself. The editor it lands on has the title
// field focused.
export const pagesPage = {
    title: () => t("pages.title"),

    async mount(root) {
        const box = h("div", { class: "list" });

        root.append(page(
            pageHead({
                title: t("pages.title"),
                icon: "file",
                actions: action({
                    label: t("pages.new"),
                    icon: "plus",
                    tone: "primary",
                    onClick: async () => {
                        try {
                            const created = await pageService.create({});
                            router.navigate(`${BASE}/${created.id}`);
                        } catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
                    }
                })
            }),
            h("p", { class: "muted" }, t("pages.hint")),
            pageSection({ body: box })
        ));

        const render = async () => {
            const pages = await pageService.list();
            // Which are already on the board, read once for the whole list rather
            // than once per row — the board is one store, and asking it per page
            // opens a transaction per page to learn one fact.
            const onBoard = new Set(
                (await Promise.all(
                    pages.map(p => kanbanService.has(`pages:${p.id}`).then(yes => (yes ? p.id : null), () => null))
                )).filter(Boolean)
            );
            box.replaceChildren(pages.length === 0
                ? emptyState(t("pages.listEmpty"), {
                    icon: "file",
                    action: null
                })
                : list(...pages.map(p => pageRow(p, {
                    onAddToBoard: onBoard.has(p.id) ? null : () => addToBoard(p)
                }))));
        };

        // Puts one page on the board. A page is a document rather than a unit of
        // work, so the board will not mark it finished — but it can be put on the
        // board to be read, and the card opens the page.
        const addToBoard = async p => {
            try {
                await kanbanService.addFromOriginal(p, { service: "pages" });
                haptics.do("ack");
                toast.show("kanban.added");
                await render();
            } catch (e) {
                toast.show(`error.${e?.code || "unexpected"}`);
            }
        };

        await render();
    }
};

// One page in the list. The whole line is the link, and the date beside it is
// when the page was last changed — which is the question a list of pages is
// asked ("which of these did I leave half-finished?"), and is not the order the
// list is sorted in, which is when it was made.
function pageRow(p, { onAddToBoard = null } = {}) {
    return listRow({
        href: `${BASE}/${p.id}`,
        icon: "file",
        title: pageLabel(p) ?? t("pages.untitled"),
        subtitle: p.description || null,
        meta: [badge(formatDate(p.updatedAt), { icon: "calendar" })],
        actions: onAddToBoard
            ? [rowAction({ label: t("kanban.addToBoard"), icon: "kanban", onClick: onAddToBoard })]
            : []
    });
}

// One page, and its lines in the order the user put them in.
//
// The title, the description and the lines all save themselves, and this screen
// never re-renders while something is being typed into, because a re-render
// would replace the very control the caret is in. It re-renders only for the
// three acts that change the SHAPE of the list: adding a line, removing one, and
// moving one.
export const pageDetail = {
    title: () => t("pages.title"),

    async mount(root, params) {
        let loaded;
        try {
            loaded = await pageService.load(params.id);
        } catch {
            notFoundView(root);
            return;
        }
        const pageId = loaded.page.id;

        // A node of its own for the head's title, so the heading can follow what
        // is being typed without rebuilding the header around it.
        const headingNode = h("span", {}, pageLabel(loaded.page) ?? t("pages.untitled"));

        const title = h("input", {
            type: "text",
            maxLength: MAX_TITLE,
            value: loaded.page.title ?? "",
            autocomplete: "off",
            placeholder: t("pages.titlePlaceholder"),
            "aria-label": t("pages.titleField")
        });
        // One optional line saying what the page is for. It is a field rather
        // than another line on the page because it is what the list is labelled
        // by, and a line the user has to scroll to find is not a label. It is
        // the shared formatting editor, so the label the list shows can carry a
        // link or two — and what is stored is still one plain string.
        const descriptionEditor = markdownEditor({
            value: loaded.page.description ?? "",
            rows: 2,
            maxLength: MAX_NOTE,
            placeholder: t("pages.descriptionPlaceholder"),
            ariaLabel: t("pages.descriptionField")
        });
        const description = descriptionEditor.textarea;

        const itemsBox = h("div", { class: "list" });

        root.append(page(
            pageHead({
                title: headingNode,
                icon: "file",
                leading: backTo(BASE),
                actions: action({
                    label: t("pages.add"),
                    icon: "plus",
                    tone: "primary",
                    onClick: () => addLine()
                })
            }),
            pageSection({
                body: h("div", { class: "form" },
                    field(t("pages.titleField"), title),
                    field(t("pages.descriptionField"), descriptionEditor.element)
                )
            }),
            pageSection({
                title: t("pages.items"),
                icon: "sort",
                body: itemsBox
            }),
            toolbar(
                action({
                    label: t("common.delete"),
                    icon: "trash",
                    tone: "danger",
                    onClick: async () => {
                        if (!await dialog.confirm("pages.deleteConfirm")) return;
                        try {
                            await pageService.remove(pageId);
                            router.navigate(BASE);
                        } catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
                    }
                })
            )
        ));

        // -- the page's own two fields --------------------------------------
        //
        // One debounce for both, and one write for both: the two are two halves
        // of the same fact about the same record, and writing one without the
        // other would send a title-only or a description-only upsert for a
        // record the other device already has a complete version of. Whichever
        // box is edited, both are read and both are written.
        //
        // The heading is refreshed from the field rather than from the saved
        // record, so it shows what is being typed and not what has been stored.
        let stored = { title: title.value, description: description.value };
        let timer = null;
        const refreshHeading = () => {
            headingNode.textContent = pageLabel({ title: title.value }) ?? t("pages.untitled");
        };
        const save = () => {
            clearTimeout(timer);
            timer = null;
            if (title.value === stored.title && description.value === stored.description) return;
            stored = { title: title.value, description: description.value };
            pageService.update(pageId, { ...stored }).catch(e => {
                toast.show(`error.${e?.code || "unexpected"}`);
            });
        };
        for (const box of [title, description]) {
            box.addEventListener("input", () => {
                if (box === title) refreshHeading();
                clearTimeout(timer);
                timer = setTimeout(save, AUTOSAVE_MS);
            });
            // Once more on blur: the debounce covers typing, and the blur covers
            // the last word typed just before tapping something else. Without it,
            // a pending save is dropped by the navigation that follows.
            box.addEventListener("blur", save);
        }
        // And once more when the tab is hidden or the page is put away, which is
        // the one case blur does not cover: on a phone the app is switched or
        // locked without any field losing focus, and the pending save dies with
        // the tab. See app/flush.js.
        onFlush(save);
        // A brand-new page is created untitled, so this is the one moment the
        // title is worth putting the caret in.
        if (title.value === "") title.focus();

        // -- the lines -------------------------------------------------------

        const renderItems = async () => {
            const items = await pageService.items(pageId);
            if (items.length === 0) {
                itemsBox.replaceChildren(emptyState(t("pages.empty"), { icon: "note" }));
                return;
            }
            // One pass for every pointer on the page, and only the services this
            // page actually needs.
            const resolved = await resolveAll(items);
            itemsBox.replaceChildren(...items.map((item, index) => pageItemNode(item, {
                index,
                count: items.length,
                resolved: resolved.get(item.id) ?? null,
                onMove: (from, to) => moveLine(item.id, to),
                onRemove: () => removeLine(item),
                onText: (node, text) => saveLine(node, text)
            })));
        };

        // Saving a line's own words writes nothing back to the screen: a
        // re-render here would destroy the textarea the caret is in.
        const saveLine = async (item, text) => {
            try {
                await pageService.updateItem(pageId, item.id, { content: { text } });
            } catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
        };

        const moveLine = async (itemId, to) => {
            try {
                await pageService.move(pageId, itemId, to);
                await renderItems();
            } catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
        };

        const removeLine = async item => {
            if (!await dialog.confirm("pages.itemDeleteConfirm")) return;
            try {
                await pageService.removeItem(pageId, item.id);
                await renderItems();
            } catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
        };

        // Adding: ask which kind, then ask for the one thing that kind needs.
        // Words are created empty and focused — there is no dialog for "type your
        // paragraph", because the page itself is where a paragraph is written.
        const addLine = async () => {
            const type = await choosePageItemKind();
            if (type === dialog.CANCELLED) return;
            try {
                if (type === "text" || type === "heading") {
                    await pageService.addItem(pageId, { type, content: { text: "" } });
                    await renderItems();
                    focusLast();
                } else if (type === "divider") {
                    await pageService.addItem(pageId, { type, content: {} });
                    await renderItems();
                } else {
                    const targetId = await chooseRecord(type);
                    if (targetId === dialog.CANCELLED) return;
                    const field = PAGE_ITEM_TARGETS[type];
                    await pageService.addItem(pageId, { type, content: { [field]: targetId } });
                    await renderItems();
                }
            } catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
        };

        // The line just added is the last one, and a newly added word-line is the
        // one thing the user wants to type into immediately.
        const focusLast = () => {
            const boxes = itemsBox.querySelectorAll(".page-text");
            const last = boxes[boxes.length - 1];
            if (last) last.focus();
        };

        await renderItems();
    }
};
