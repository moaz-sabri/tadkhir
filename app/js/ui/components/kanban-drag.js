import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { uiIcon } from "../icons.js";
import { haptics } from "../../app/haptics.js";

// Dragging a card between columns, on a mouse AND on a finger.
//
// WHY POINTER EVENTS AND NOT THE HTML5 DRAG API
//
// `draggable="true"` and dragstart/dragover/drop are the obvious way to do this
// and they are what the first version of this board used. They do not work on a
// touchscreen at all: iOS Safari and Android Chrome fire no drag events for a
// touch, so on a phone — which is where this app is mostly used — the board had
// four columns and no way to move anything between them. That is not a degraded
// experience, it is a dead screen.
//
// Pointer Events are the one input model that covers mouse, pen and touch with
// the same three handlers, so there is a single drag implementation and a single
// set of bugs. `setPointerCapture` is what makes it work: once the pointer is
// captured by the card, every subsequent move and the final release are delivered
// to that card even when the finger has travelled off it and over another column,
// which is the entire behaviour a drag needs and the thing a touch screen cannot
// do without it.
//
// WHAT ELSE THIS SOLVES
//
//   * A tap is not a drag. The drag only begins after the pointer has travelled
//     past a threshold, so a tap on a card still opens it and a tap on the small
//     "move" control still opens the menu. Without the threshold, every attempt
//     to tap a card started a drag.
//   * Scrolling still works. `touch-action` is left alone on the cards (the CSS
//     asks the browser not to claim the gesture vertically) so a finger dragged
//     down a column scrolls the list instead of dragging the card, and only a
//     deliberate sideways-and-lift movement picks a card up.
//   * The keyboard can do it too. Drag is never the only way to move a card:
//     every card carries a menu with the four columns in it, which is also what
//     makes the board usable one-handed and by a screen reader.
//
// The card that follows the finger is a CLONE, not the original. The original
// stays in place, dimmed, as the thing being moved — so if the drag is abandoned
// the board is already correct, and there is no "put it back" code path that
// could leave a card somewhere that is not a column.

const DRAG_THRESHOLD_PX = 8;
// Long enough not to fire on a tap, short enough that a deliberate drag does not
// feel like it waited.
const HOLD_MS = 140;

// One drag at a time. A second pointer arriving mid-drag (a second finger on a
// phone) is ignored rather than starting a competing drag with two clones.
let active = null;
// The teardown of the drag in progress, so a page that is unmounted mid-drag can
// end it. The pointerdown handler is on the board and dies with it, but the three
// document-level listeners a drag installs belong to `document`, not to the board,
// and would keep a ghost on screen over whatever page replaced this one.
let abort = null;

export function isDragging() {
    return active !== null;
}

/**
 * Makes a board draggable.
 *
 *   columns   a Map of status -> the element that accepts cards. Each element
 *             carries `data-status`, which is what a drop reads to know where the
 *             card landed, so a caller cannot get the two out of step.
 *   onDrop    (id, status) => void, called after the drag ends over a column.
 *             Async is fine; the board shows the card in its new place when it
 *             resolves and puts it back when it rejects.
 *
 * Returns the teardown, which the page must call on unmount. Every listener here
 * is attached to an element the page owns, so it dies with them — but the
 * document-level listeners below do not, and a page left mounted by a navigation
 * would keep a drag handler alive on a board that is no longer on screen.
 */
export function draggableBoard({ columns, onDrop, onDragStateChange = null }) {
    const teardowns = [];
    const on = (el, type, handler, opts) => {
        el.addEventListener(type, handler, opts);
        teardowns.push(() => el.removeEventListener(type, handler, opts));
    };

    for (const [status, el] of columns) {
        // A column is a drop target for a card coming from anywhere, including
        // from another column and from outside the board (a card on a row).
        on(el, "dragover", e => {
            // Only the native drag from an HTML5 draggable, if anything, needs
            // this. The pointer drag finds its column by hit-testing, so it does
            // not go through here.
            if (!e.dataTransfer) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            el.classList.add("is-drop-target");
        });
        on(el, "dragleave", () => el.classList.remove("is-drop-target"));
        on(el, "drop", e => {
            el.classList.remove("is-drop-target");
            const id = e.dataTransfer?.getData("text/plain");
            if (!id) return;
            e.preventDefault();
            onDrop(id, status);
        });
    }

    // The whole board delegates: a card that is re-rendered is still draggable,
    // because the handler is on the board and not on any one card. A board that
    // attached dragstart to each card lost dragging after every re-render, which
    // is every save, every sync pull and every midnight tick.
    //
    // The board is found from the COLUMNS rather than being passed in, because a
    // column is created before the element that holds all of them, and threading
    // the order through by hand is one more thing a caller can get wrong. It is
    // found once, here, and the pointer handler is attached to that element — so
    // it dies with the board's own teardown below.
    const board = columns.values().next().value?.closest("[data-kanban-board]");

    const onPointerDown = e => {
        // Another drag owns the board. Checked before anything else so a second
        // finger landing mid-drag cannot start a competing one.
        if (active) return;
        // A secondary button is a context menu, not a drag.
        if (e.pointerType === "mouse" && e.button !== 0) return;
        const card = e.target.closest?.("[data-kanban-card]");
        // A press on a control inside a card is that control's press. Without this
        // the delete button on a card would pick the card up instead of deleting.
        if (!card || e.target.closest("button, a, input, textarea, select")) return;

        const boardEl = card.closest("[data-kanban-board]");
        if (!boardEl) return;

        const startX = e.clientX;
        const startY = e.clientY;
        let ghost = null;
        let armed = true;
        let target = null;

        const clearTarget = () => {
            if (target) target.classList.remove("is-drop-target");
            target = null;
        };

        /**
         * Picks the card up: the pointer is captured so its moves keep arriving
         * after it leaves the card, the ghost appears, and the card in place is
         * dimmed so the column it came from does not close up under the finger.
         *
         * Both entry points — a finger that travelled past the threshold, and a
         * finger held still long enough to count as a long press — go through
         * here, and it is guarded on `ghost` because of that. Doing the work twice
         * would put two ghosts on screen and leave the first one there for good,
         * because only the most recent one is ever removed.
         */
        const lift = ev => {
            if (ghost) return;
            capture(card, ev.pointerId);
            ghost = makeGhost(card);
            document.body.append(ghost);
            card.classList.add("is-dragging");
            onDragStateChange?.(true);
            // A lift is a thing that happened, not a choice being registered, so
            // it gets the same short pulse as a dialog answer.
            haptics.do("ack");
        };

        const onPointerMove = ev => {
            if (armed) {
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                // Past the threshold: this is a drag.
                if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
                armed = false;
                lift(ev);
            }
            positionGhost(ghost, ev.clientX, ev.clientY);
            const over = columnAt(boardEl, ev.clientX, ev.clientY);
            if (over !== target) {
                clearTarget();
                if (over) over.classList.add("is-drop-target");
                target = over;
            }
        };

        const finish = async ev => {
            // READ THE TARGET BEFORE TEARING DOWN. `clearTarget` empties the very
            // variable that says where the card was dropped, so reading it after
            // the cleanup gives null every single time — and a drag that highlights
            // the column under the finger and then quietly does nothing is the
            // most confusing failure this component could have. The column under
            // the pointer IS the answer; take it first, then tidy up.
            const status = target?.dataset.status;

            teardown();
            releaseCapture(card, ev);
            // ALWAYS release the board, not only when a drag actually happened.
            // `active` is the one-drag-at-a-time lock, and a TAP takes it too — it
            // is taken at pointerdown, before anyone knows whether the finger is
            // going to move. Clearing it only on the drag path left the board
            // permanently locked by the first tap on any card, so the second drag
            // the user ever attempted did nothing at all, and the only way out was
            // to reload the page.
            active = null;
            abort = null;

            // Released without ever passing the threshold: it was a tap. Nothing
            // is moved, and the card's own handlers deal with the tap.
            if (armed) return;

            if (status && status !== card.dataset.status) {
                await onDrop(card.dataset.kanbanCard, status);
            } else if (!status) {
                // Released over nothing — off the board entirely. Reported so the
                // board can leave the card where it was; it was never moved, so
                // there is nothing here to undo.
                onDrop(null, null);
            }
        };

        const onPointerUp = ev => finish(ev);

        /**
         * The system took the gesture — a scroll, a notification shade, a second
         * finger arriving.
         *
         * This path reports NO drop at all, deliberately. A cancelled gesture is
         * not a gesture that ended somewhere; it is one that never happened, and
         * the board is still correct because nothing was written. Calling onDrop
         * here would make the board treat "abandoned" as "released over nothing"
         * and start undoing a move the user never made.
         */
        const onPointerCancel = () => {
            abort?.();
        };

        /** Every listener this press installed, off. Order is irrelevant. */
        const teardown = () => {
            document.removeEventListener("pointermove", onPointerMove);
            document.removeEventListener("pointerup", onPointerUp);
            document.removeEventListener("pointercancel", onPointerCancel);
            clearTimeout(holdTimer);
            card.classList.remove("is-dragging");
            clearTarget();
            onDragStateChange?.(false);
            ghost?.remove();
            ghost = null;
        };

        // Held this long without moving: also a lift, on a touch screen where the
        // finger is not going to travel much. A long press is the gesture people
        // already know for "pick this up" on a phone, and without it a card that
        // is 40px from the column you want has no comfortable way to get there.
        let holdTimer = null;
        if (e.pointerType !== "mouse") {
            holdTimer = setTimeout(() => {
                // Already lifted by a movement, or another drag owns the board.
                if (!armed || active) return;
                armed = false;
                lift(e);
                positionGhost(ghost, startX, startY);
            }, HOLD_MS);
        }

        active = { id: card.dataset.kanbanCard };
        // Ending the drag is one thing from three places — a release, a cancel,
        // and the page being unmounted underneath it — so it is named once here
        // rather than written three times.
        abort = () => {
            teardown();
            releaseCapture(card, null);
            active = null;
            abort = null;
        };
        document.addEventListener("pointermove", onPointerMove, { passive: true });
        document.addEventListener("pointerup", onPointerUp);
        document.addEventListener("pointercancel", onPointerCancel);
    };

    if (board) on(board, "pointerdown", onPointerDown);

    return () => {
        for (const fn of teardowns.splice(0)) fn();
        // A drag in progress when the page is left must not survive it. The
        // pointerdown handler is on the board and dies with it, but the three
        // document-level listeners a drag installs belong to `document`, and would
        // keep a ghost on screen over whatever page replaced this one.
        abort?.();
        active = null;
        abort = null;
    };
}

/**
 * Takes the pointer, so its moves keep arriving even off the card.
 *
 * Fails harmlessly for a pointer the browser has already given up on, which is
 * the same reason `releaseCapture` below is defensive: capture is an optimisation
 * that makes dragging reliable, not the mechanism the drag itself depends on. If
 * it cannot be taken, the document-level listeners already installed still carry
 * the drag to its end.
 */
function capture(card, pointerId) {
    if (pointerId == null) return;
    try {
        card.setPointerCapture?.(pointerId);
    } catch {
        /* the pointer is gone; the document listeners will finish the job */
    }
}

/**
 * Gives up the pointer capture, if this card ever took it.
 *
 * `releasePointerCapture` THROWS when the element does not hold a capture for
 * that pointer id, and it is not an exception anyone expects from cleanup code.
 * Two ordinary paths reach it without a capture ever having been taken: a tap,
 * which never passed the threshold, and a pointer the browser has already
 * released by the time the handler runs. Both produce an unhandled rejection in
 * the console on a screen that is otherwise working perfectly, which trains
 * everyone who reads that console to ignore it — and the next real error there
 * goes unread too.
 *
 * Capture not being held is the normal case, not an error, so it is swallowed.
 */
function releaseCapture(card, ev) {
    const id = ev?.pointerId;
    if (id == null) return;
    try {
        card.releasePointerCapture?.(id);
    } catch {
        /* there was nothing to release */
    }
}

/**
 * The card that follows the finger.
 *
 * A fixed-position clone positioned by transform rather than by `top`/`left`,
 * because writing layout properties every pointermove forces a reflow of the
 * whole board on every frame; a transform is composited and does not. The clone
 * carries no id and no tabindex, so it cannot be reached by the keyboard and
 * cannot be clicked — it is a picture of a card, and the card it was copied from
 * is still on the board doing the real work.
 */
function makeGhost(card) {
    const rect = card.getBoundingClientRect();
    const ghost = h("div", { class: "kanban-ghost", "aria-hidden": "true" },
        h("div", { class: "kanban-card" },
            h("div", { class: "kanban-card-title" }, card.querySelector(".kanban-card-title")?.textContent ?? "")
        )
    );
    ghost.style.width = `${rect.width}px`;
    ghost.style.setProperty("--ghost-x", `${rect.left}px`);
    ghost.style.setProperty("--ghost-y", `${rect.top}px`);
    return ghost;
}

function positionGhost(ghost, x, y) {
    if (!ghost) return;
    const dx = x - parseFloat(ghost.style.getPropertyValue("--ghost-x") || "0");
    const dy = y - parseFloat(ghost.style.getPropertyValue("--ghost-y") || "0");
    ghost.style.transform = `translate(${dx}px, ${dy}px) rotate(1.5deg)`;
}

/** The column under a point, or null. Tested from the top down. */
function columnAt(board, x, y) {
    const el = document.elementFromPoint(x, y);
    const column = el?.closest?.("[data-status]");
    return column && board.contains(column) ? column : null;
}

/**
 * The move menu.
 *
 * Every column, as a choice, for a card. This is not a fallback for people who
 * cannot drag — it is the only way to move a card that is one-handed, with a
 * screen reader, or from a keyboard, and it is the reason a drag failure can
 * never make a card immovable.
 */
export function moveMenu(item, { onMove, canComplete }) {
    // "Done" is offered ONLY when the card's own service can be finished, and a
    // card already in "done" always keeps it so it can be moved back out.
    //
    // Offering it anyway — disabled, or greyed, or working-then-failing — is the
    // worst of the three. It makes the menu promise something the app cannot do,
    // and the failure arrives as an error toast after a confirmation the user was
    // told to expect to succeed. So the option is simply not there, and the note
    // below says why the four columns are three.
    const columns = [
        { key: "have", icon: "inbox", label: "kanban.have" },
        { key: "working", icon: "play", label: "kanban.working" },
        { key: "done", icon: "check", label: "kanban.done", needsComplete: true },
        { key: "deferred", icon: "clock", label: "kanban.deferred" }
    ].filter(col => !col.needsComplete || canComplete || item.status === "done");

    const buttons = columns.map(col => h("button", {
        class: `kanban-move-option${item.status === col.key ? " is-current" : ""}`,
        type: "button",
        // The column the card is in now, which is also the one the menu marks.
        "aria-current": item.status === col.key ? "true" : "false",
        onClick: () => onMove(col.key)
    },
        h("span", { class: "kanban-move-glyph" }, uiIcon(col.icon, { className: "icon" })),
        t(col.label)
    ));

    // Said in words rather than left to be inferred from a missing button: a menu
    // with three options where there are four, and no explanation, reads as a bug.
    if (!canComplete && item.status !== "done") {
        buttons.push(h("p", { class: "muted kanban-move-note" }, t("kanban.cannotComplete")));
    }

    return h("div", { class: "kanban-move" },
        h("p", { class: "kanban-move-title" }, t("kanban.moveTo")),
        h("div", { class: "kanban-move-grid" }, ...buttons)
    );
}
