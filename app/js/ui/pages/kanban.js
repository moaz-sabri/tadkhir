import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import {
    page,
    pageHead,
    pageSection,
    action,
    emptyState,
    badge,
    rowAction
} from "../components/ui.js";
import { kanbanService } from "../../services/kanban-service.js";
import { bus } from "../../app/bus.js";
import { dialog } from "../components/dialog.js";
import { toast } from "../components/toast.js";
import { router } from "../../app/router.js";
import { haptics } from "../../app/haptics.js";
import { KANBAN_COLUMNS, generateTodayKey, hrefFor } from "../../domain/kanban.js";
import { draggableBoard, moveMenu } from "../components/kanban-drag.js";
import { formatDateTime } from "../../domain/time.js";

// The board.
//
// Four columns and a card is a pointer to a record some other service owns. The
// board never becomes a second copy of anything: it holds a column, a position
// and a day, and every word on a card is a label cached from the service it
// points at. Opening a card opens the real record.
//
// Two things this screen has to get right that a board usually does not:
//
//   1. Finishing is the original service's action, not the board's. Dropping a
//      card into "done" asks first, then calls the service, and only records the
//      move if that succeeded. The reverse order — move, then try — is how a
//      board ends up claiming something is finished that is not.
//
//   2. Moving a card must work on a finger. See components/kanban-drag.js for why
//      that is not the HTML5 drag API, and note that every card also carries a
//      menu with the four columns in it, so the board is fully operable without
//      dragging at all.
//
// A NOTE ON SHAPE, because it bit this screen once: every helper below is a
// `function` declaration rather than a `const`. The page is built by ONE
// expression that passes `openPicker` and friends straight into a button, and
// that expression runs before the bottom half of this function has been
// evaluated. A `const` arrow function is hoisted but not initialized, so
// handing one to a button at that point throws "cannot access before
// initialization" — and it throws on the FIRST page load, in production, for a
// reason that looks nothing like its cause. Function declarations are hoisted
// AND initialized, so building the page before the helpers exist is simply not
// a mistake that can be made here.
export const kanbanPage = {
    title: () => t("kanban.title"),

    async mount(root) {
        // One list holding everything mount() set up: the bus subscription, the
        // drag listeners and the midnight timer. A page that leaves any of them
        // behind keeps re-rendering after the user has navigated away, and keeps
        // answering drags on a board that is not on screen.
        const teardowns = [];

        const columns = new Map();
        const board = h("div", { class: "kanban-board", "data-kanban-board": "true" });

        for (const col of KANBAN_COLUMNS) {
            const count = h("span", { class: "kanban-column-count" });
            const list = h("div", { class: "kanban-list", "data-status": col.key });
            board.append(
                h("section", { class: "kanban-column", "data-column": col.key },
                    h("header", { class: "kanban-column-header" },
                        h("span", { class: "kanban-column-name" }, t(col.label)),
                        count
                    ),
                    list
                )
            );
            columns.set(col.key, { list, count });
        }

        const boardHost = h("div", { class: "kanban-board-host" });
        const empty = h("div", { class: "kanban-empty", hidden: true });

        // The day the board on screen belongs to. Every card is filtered against
        // it, so it is recorded rather than recomputed at each read: a board
        // rendered at 23:58 and read at 00:01 must not answer two different
        // questions about what "today" means.
        let renderedDay = generateTodayKey();

        // A second render while the first is in flight is dropped, not queued:
        // the first is already reading the same rows, and queueing them means two
        // full renders racing to write the same DOM.
        let inFlight = null;

        // -------------------------------------------------- the card

        function cardFor(item) {
            const href = hrefFor(item);
            const label = item.originalData?.title || t("kanban.untitled");
            const canComplete = kanbanService.canComplete(item);
            const menuHost = h("div", { class: "kanban-menu", hidden: true });

            const card = h("article", {
                class: `kanban-card kanban-card-${item.status}`,
                "data-kanban-card": item.id,
                "data-status": item.status,
                // The card is focusable and says where it is and where it can go,
                // so the board is navigable without seeing it.
                tabindex: "0",
                role: "group",
                "aria-label": `${label}. ${t(`kanban.${item.status}`)}`
            },
                h("div", { class: "kanban-card-top" },
                    h("span", { class: "kanban-card-title" }, label),
                    h("span", { class: "kanban-card-actions" },
                        // Open the original. Following the pointer is what a card
                        // is for, and it is a real link so middle-click and
                        // "copy link address" behave as they do on every other row.
                        href ? rowAction({ label: t("kanban.openOriginal"), icon: "external", href }) : null,
                        rowAction({
                            label: t("kanban.moveTo"),
                            icon: "sliders",
                            onClick: () => {
                                menuHost.hidden = false;
                                menuHost.replaceChildren(moveMenu(item, {
                                    canComplete,
                                    onMove: async status => {
                                        menuHost.hidden = true;
                                        await requestMove(item, status);
                                    }
                                }));
                                menuHost.querySelector(".kanban-move-option")?.focus();
                            }
                        }),
                        rowAction({
                            label: t("kanban.removeFromBoard"),
                            icon: "close",
                            onClick: () => removeFromBoard(item)
                        })
                    )
                ),
                // The minimum a card needs to be useful and nothing more: where it
                // came from, and when it is due. Everything else is on the record.
                h("div", { class: "kanban-card-meta" },
                    badge(t(`kanban.from.${item.service}`), { icon: serviceIcon(item.service) }),
                    item.originalData?.dueAt
                        ? badge(formatDateTime(item.originalData.dueAt), {
                            icon: "calendar",
                            tone: item.originalData.dueAt < Date.now() ? "danger" : ""
                        })
                        : null
                ),
                menuHost
            );

            // Enter opens the original, the same as a tap. A card that can only be
            // acted on by dragging it is a card a keyboard cannot reach.
            card.addEventListener("keydown", e => {
                if (e.key !== "Enter" || !href) return;
                e.preventDefault();
                router.navigate(href);
            });

            return card;
        }

        // -------------------------------------------------- moving a card

        /**
         * The one path a card takes to another column, whoever asked: a drag, the
         * menu, or a keyboard. Confirming, calling the original service and
         * reporting a failure all happen here, so the three ways in cannot
         * disagree about what "moving to done" means.
         */
        async function requestMove(item, status) {
            if (!status || status === item.status) return;

            if (status === "done" && !kanbanService.canComplete(item)) {
                // A DRAG into "done" is the way this is reached without the move
                // menu, and the menu hides the option — but a drag has no idea
                // what the card's service supports, so it has to be refused here
                // rather than after a confirmation that cannot succeed. A card
                // already in "done" is exempt: it is on its way out, and the move
                // back to a working column is always allowed.
                if (item.status !== "done") {
                    toast.show("kanban.cannotComplete");
                    await render();
                    return;
                }
            }

            if (status === "done") {
                const ok = await dialog.confirm("kanban.doneConfirm");
                // Nothing was changed, so there is nothing to redraw: the card is
                // still in its column because it never left it.
                if (!ok) return;
                try {
                    // Kanban coordinates, the original service executes. If this
                    // rejects, the card stays put and the reason is on screen.
                    await kanbanService.complete(item.id);
                    haptics.do("ack");
                } catch (e) {
                    toast.show(`error.${e?.code || "unexpected"}`);
                    return;
                }
                await render();
                return;
            }

            try {
                await kanbanService.move(item.id, status, null);
                haptics.do("ack");
            } catch (e) {
                toast.show(`error.${e?.code || "unexpected"}`);
            }
            await render();
        }

        async function removeFromBoard(item) {
            if (!await dialog.confirm("kanban.deleteConfirm")) return;
            try {
                // Only the pointer goes. The task or note it pointed at is not
                // touched: taking a card off a board is not deleting the thing on
                // it, and a dialog that implied otherwise would be a lie.
                await kanbanService.remove(item.id);
            } catch (e) {
                toast.show(`error.${e?.code || "unexpected"}`);
            }
            await render();
        }

        // -------------------------------------------------- adding a card

        /**
         * "Add from a list", for a card whose original already exists.
         *
         * The board creates no records of its own — that would make it a second
         * way to make a task, and the two would not agree. So this opens a list
         * and adds a card for something already there.
         */
        async function openPicker() {
            const answer = await dialog.choose("kanban.addPrompt", [
                { label: "kanban.addFromTasks", value: "tasks", icon: "tasks", class: "primary" },
                { label: "kanban.addFromLater", value: "later", icon: "bookmark" },
                { label: "common.cancel", icon: "close" }
            ]);
            if (answer === "tasks") router.navigate("/tasks");
            else if (answer === "later") router.navigate("/later");
        }

        // -------------------------------------------------- drawing

        function draw(groups) {
            for (const { status, items } of groups) {
                const { list, count } = columns.get(status);
                // Replaced rather than emptied and refilled: replaceChildren takes
                // the new nodes in one operation, so there is no frame in which
                // the column is half-empty and a card landing in it would hit
                // nothing.
                list.replaceChildren(...items.map(cardFor));
                count.textContent = items.length ? String(items.length) : "";
            }

            // An empty board says so INSTEAD of showing four empty columns. Four
            // wells with nothing in them above a sentence explaining that there is
            // nothing is two answers to one question, and the emptier of the two
            // reads as a broken screen. So the board is hidden rather than
            // emptied, and the empty state stands on its own with the way in.
            const total = groups.reduce((n, g) => n + g.items.length, 0);
            const isEmpty = total === 0;
            board.hidden = isEmpty;
            empty.hidden = !isEmpty;
            if (!isEmpty) return;
            empty.replaceChildren(
                emptyState(t("kanban.empty"), {
                    icon: "kanban",
                    action: action({
                        label: t("kanban.addFromList"),
                        icon: "plus",
                        tone: "primary",
                        onClick: openPicker
                    })
                })
            );
        }

        async function render() {
            if (inFlight) return inFlight;
            inFlight = (async () => {
                try {
                    // Orphans first, so a card whose original is gone is removed
                    // before the board is drawn and nobody is shown a card they
                    // cannot open. Then labels, because the label on a card is a
                    // copy and a task renamed elsewhere would otherwise keep the
                    // name it had when it was added.
                    await kanbanService.dropOrphans();
                    await kanbanService.refreshLabels();
                    draw(await kanbanService.board({ todayKey: renderedDay }));
                } catch (e) {
                    toast.show(`error.${e?.code || "unexpected"}`);
                } finally {
                    inFlight = null;
                }
            })();
            return inFlight;
        }

        // -------------------------------------------------- the page itself

        root.append(page(
            pageHead({
                title: t("kanban.title"),
                icon: "kanban",
                actions: [
                    action({
                        label: t("kanban.addFromList"),
                        icon: "plus",
                        tone: "primary",
                        onClick: openPicker
                    })
                ]
            }),
            pageSection({ body: boardHost })
        ));

        boardHost.append(board, empty);

        // -------------------------------------------------- wiring

        teardowns.push(draggableBoard({
            columns: new Map([...columns].map(([k, v]) => [k, v.list])),
            onDrop: async (id, status) => {
                if (!id) return;
                try {
                    await requestMove(await kanbanService.get(id), status);
                } catch (e) {
                    toast.show(`error.${e?.code || "unexpected"}`);
                }
            }
        }));

        teardowns.push(bus.on("data-changed", () => { void render(); }));

        // Midnight. The board shows today, so a board left open overnight is
        // showing yesterday — with no navigation, no save and no sync to make the
        // screen redraw. The check is one string comparison against the day the
        // board was rendered, so it costs nothing to ask, and it is the only thing
        // that can notice the day has turned over.
        const midnight = setInterval(() => {
            const today = generateTodayKey();
            if (today === renderedDay) return;
            renderedDay = today;
            void render();
        }, 30_000);
        teardowns.push(() => clearInterval(midnight));

        await render();

        kanbanPage._teardown = () => {
            for (const fn of teardowns.splice(0)) fn();
        };
    },

    unmount() {
        kanbanPage._teardown?.();
        kanbanPage._teardown = null;
    }
};

/** The glyph that says where a card came from. One per service, never generic. */
function serviceIcon(service) {
    switch (service) {
        case "tasks": return "tasks";
        case "later": return "bookmark";
        case "pages": return "file";
        default: return "inbox";
    }
}
