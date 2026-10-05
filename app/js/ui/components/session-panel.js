import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { uiIcon } from "../icons.js";
import { formatClock } from "../../domain/time.js";
import { hasEstimate } from "../../domain/session-engine.js";
import { MAX_DURATION_MS, MAX_NOTE } from "../../domain/validation.js";
import { sessionService } from "../../services/session-service.js";
import { store } from "../../app/store.js";
import { router } from "../../app/router.js";
import { haptics } from "../../app/haptics.js";
import { dialog } from "./dialog.js";
import { toast } from "./toast.js";
import { timeStage } from "./display.js";
import { action, stat, card, sectionTitle } from "./ui.js";

// The session panel: the counter (ascending — starts at 0:00 and counts up,
// capped at 72 h), the progress readout for task-backed sessions, the checklist
// (session-scoped subtasks) with add / remove / toggle, and a journal note that
// is saved with the session.
//
// Built in two COLUMNS, because they are read at two distances. The STAGE is one
// of them and carries only what you read from across a desk: the counter, the
// task name, the status, the wall clock and the estimate as a ring. Everything
// else — controls, checklist, note — is the other, read up close and tapped.
//
// The split is a grid rather than a page mode, and it is decided by width:
// narrow puts the work under the stage, wide puts it beside it. And in BOTH the
// stage does not move — it is sticky, so ticking a subtask, which focuses the
// checkbox and scrolls it into view, cannot push the counter off the top of the
// screen. That is not a nicety: it is the whole reason this page is opened. A
// timer that jumps because a checklist grew a row is a timer you stop trusting.
//
// Both columns are always present. A "presentation mode" to toggle is a thing to
// discover, and a display on a wall has nobody to discover it with.
//
// The second argument is an OPTION, and it used to be a bare `onChange`
// callback — which its one caller did not pass, having read the parameter as an
// options bag and sent `{ stage: true }`. `await onChange()` on that object threw
// a TypeError inside the transition, so every pause, resume and finish on this
// screen was caught, reported as "Something went wrong", and the state change
// that had already been written was reported as a failure. Nothing about it was
// visible from the session's own state, which is why it survived. An options
// object cannot be called by accident, and the one option this panel has is
// named.
export function sessionPanel(session, { onChange = () => {} } = {}) {
    let timer = null;
    // Most recent known session. Service results are applied to `current`
    // immediately (the store refresh lags), so pause/resume and checklist ops
    // always re-render from fresh data.
    let current = session;
    // What the stage last showed, and whether it has shown anything yet. A pulse
    // is for a CHANGE, and the first render of a panel is the session appearing
    // rather than a transition — so that one is deliberately silent, and a
    // session that was already running when the page was opened does not greet
    // the user with a flash for a transition they did not cause.
    let lastStatus = session.status;
    let seen = false;

    // The stage. `progress` decides whether the estimate is drawn as a ring
    // around the counter (task-backed sessions) or not shown at all (free ones,
    // which have no estimate to be against) — decided ONCE here, not on every
    // tick, because the ring's element cannot appear and disappear without the
    // stage rebuilding around it. "Has an estimate" is the engine's own answer
    // (hasEstimate), which is the same rule `isOver` and the session chip use —
    // it used to be written out longhand here, in the chip and in two other
    // places, free to drift.
    const taskBacked = hasEstimate(session);
    const stage = timeStage({
        title: session.taskTitle || t("session.free"),
        status: t(`session.${session.status}`),
        icon: taskBacked ? "target" : "clock",
        progress: taskBacked
    });
    const counter = stage.counter;
    const checklistRoot = h("div", { class: "session-checklist" });
    // The session's own controls, in their own block rather than as a page-level
    // toolbar. They are the one thing on this screen that is read from a distance
    // and pressed without aiming, so they sit directly under the stage where the
    // eye already is.
    //
    // NOT a `.toolbar`: a toolbar wraps and shares a line, and a wrap would move
    // the destructive button to the first line on a narrow screen. This is a grid,
    // which cannot reorder — see the note on `.session-controls` in the
    // stylesheet.
    const buttons = h("div", { class: "session-controls" });

    // The elapsed/remaining figures. They live UNDER the stage, not in it: at
    // stage size a two-cell stat row is a strip of small text directly under a
    // number large enough to read from across the room, which competes with it
    // rather than informing it. Down here they are the reference figures, read
    // up close.
    const elapsedStat = stat({ label: t("session.elapsed"), value: "0:00", icon: "clock" });
    const remainingStat = stat({ label: t("session.remaining"), value: "0:00", icon: "target" });
    const elapsedValue = elapsedStat.querySelector(".stat-value");
    const remainingValue = remainingStat.querySelector(".stat-value");

    // The stage's wall clock, on its own timer and NOT the tick below.
    //
    // The tick stops the moment the session stops, because a paused session's
    // elapsed figure is frozen and there is genuinely nothing to redraw. A clock
    // that froze with it would be useless on exactly the screen it was added for:
    // the one you have open while working, which is the one most likely to be
    // paused — and pausing is exactly when a person glances at a clock to decide
    // whether to start again. Once a second, skipped while the page is hidden,
    // which is what the chip's timer does too.
    const clockTimer = setInterval(() => {
        if (document.hidden) return;
        stage.setNow(Date.now());
    }, 1000);

    // The remaining figure only means something when there is an estimate to be
    // against, so the whole cell is dropped for a free session rather than
    // showing a confident 0:00 that nobody asked for.
    const progress = h("div", { class: "session-progress", hidden: !taskBacked },
        h("div", { class: "session-stats" }, elapsedStat, ...(taskBacked ? [remainingStat] : []))
    );

    // Journal note: a free-form log of what was done in this session, saved
    // with the session record (shown again on the session detail page).
    const noteInput = h("textarea", {
        class: "note-input",
        maxLength: MAX_NOTE,
        rows: 4,
        placeholder: t("session.notePlaceholder"),
        "aria-label": t("session.notePlaceholder")
    });
    noteInput.value = session.note ?? "";
    const noteSave = action({
        label: t("session.saveNote"),
        icon: "check",
        onClick: () => saveNote()
    });
    // Its own card, beside the details card above it. It used to be a bare field,
    // which was right while the whole panel was one box and the field sat inside
    // it; the panel is frameless now, and a note floating on the black under a
    // bordered card is the one thing on this screen that looks unfinished.
    //
    // A heading rather than the `field()` caption it replaced, and the textarea
    // carries its own `aria-label`, so nothing is lost by not being a `<label>`:
    // clicking a heading to focus a textarea is a convenience, not a label.
    const noteSection = card(
        sectionTitle(t("session.note"), { icon: "bookmark" }),
        noteInput,
        h("div", { class: "form-actions" }, noteSave)
    );

    // Checklist row registry: rebuilt only when the item set changes, synced in
    // place on time ticks so checkbox focus/input text are never lost.
    const checklistRows = new Map();

    const itemIds = s => (s.taskItems || []).map(i => i.id).join("|");
    let lastIds = itemIds(session);

    // Prefer the freshest known session: `current` carries the last service
    // result; the store copy is only consulted when it is at least as new (the
    // store refresh finishes after the write, so it converges to the same data).
    function live() {
        const active = store.getState().active;
        if (active && active.id === current.id && (active.updatedAt || 0) >= (current.updatedAt || 0)) return active;
        return current;
    }

    function stats(cur) {
        const now = Date.now();
        const rawElapsed = cur.segments.reduce((a, s) => a + Math.max(0, (s.end ?? now) - s.start), 0);
        // A session stops counting at the 72 h ceiling; the UI warns instead.
        const elapsed = Math.min(rawElapsed, MAX_DURATION_MS);
        return {
            elapsed,
            durationCapped: rawElapsed >= MAX_DURATION_MS,
            estimateReached: hasEstimate(cur) && elapsed >= cur.estimatedMs
        };
    }

    async function apply(fn) {
        try {
            const result = await fn();
            // Session ended: leave the page. The strip (hidden on this page)
            // reacts to the active session becoming null on its own.
            if (result?.status === "completed" || result?.status === "cancelled") {
                current = result;
                if (result.status === "completed") {
                    // The one toast in the app that reports a result the user
                    // asked for. The page is about to be replaced underneath them,
                    // and a session that has just been ended is the one moment
                    // where the figure they would otherwise have to remember —
                    // how long it was — is worth saying out loud.
                    toast.show("session.completedToast", { time: formatClock(result.actualMs ?? 0) });
                }
                router.navigate("/");
                return;
            }
            if (result) current = result;
            await onChange();
            render();
        } catch (e) {
            // The toast carries the message; the pulse for a failed action comes
            // from toast.js, so every failure in the app answers the same way.
            toast.show(`error.${e?.code || "unexpected"}`);
        }
    }

    async function toggleItem(it, input) {
        input.disabled = true;
        try {
            const result = await sessionService.toggleTask(it.id, input.checked);
            current = result || current;
            render();
        } catch (e) {
            input.checked = !input.checked;
            toast.show(`error.${e?.code || "unexpected"}`);
        } finally {
            input.disabled = false;
        }
    }

    function addItem(addInput, addBtn) {
        const value = addInput.value.trim();
        if (!value) {
            addInput.focus();
            return;
        }
        addInput.value = "";
        addBtn.disabled = true;
        sessionService.addItem(value)
            .then(result => {
                current = result || current;
                render();
            })
            .catch(e => {
                addInput.value = value;
                toast.show(`error.${e?.code || "unexpected"}`);
            })
            .finally(() => { addBtn.disabled = false; });
    }

    function removeItem(id) {
        sessionService.removeItem(id)
            .then(result => {
                current = result || current;
                render();
            })
            .catch(e => toast.show(`error.${e?.code || "unexpected"}`));
    }

    async function saveNote() {
        noteSave.disabled = true;
        try {
            const result = await sessionService.saveNote(current.id, noteInput.value);
            current = result || current;
            noteInput.value = current.note ?? "";
            render();
            toast.show("session.noteSaved");
        } catch (e) {
            toast.show(`error.${e?.code || "unexpected"}`);
        } finally {
            noteSave.disabled = false;
        }
    }

    function buildChecklist(s) {
        const items = s.taskItems || [];
        checklistRoot.replaceChildren();
        checklistRows.clear();
        checklistRoot.append(h("div", { class: "check-head" }, t("session.tasks")));
        for (const it of items) {
            const input = h("input", { type: "checkbox", "aria-label": it.title });
            const row = h("div", { class: "check-row" },
                input,
                h("span", { class: "check-title" }, it.title),
                h("button", {
                    type: "button",
                    class: "check-remove",
                    "aria-label": t("session.removeItem"),
                    title: t("session.removeItem"),
                    onClick: () => removeItem(it.id)
                }, uiIcon("close", { className: "icon icon-sm" }))
            );
            input.checked = !!it.completed;
            row.classList.toggle("done", !!it.completed);
            input.addEventListener("change", () => toggleItem(it, input));
            checklistRows.set(it.id, { input, row });
            checklistRoot.append(row);
        }
        const addInput = h("input", {
            type: "text",
            maxLength: 120,
            placeholder: t("session.addItemPlaceholder"),
            "aria-label": t("session.addItemPlaceholder")
        });
        // A plus is the whole meaning of "add one more of these", and a word here
        // is a word in a 360px-wide panel that already has a timer, a checklist
        // and a note in it.
        const addBtn = h("button", {
            type: "button",
            class: "btn icon-only",
            "aria-label": t("common.add"),
            title: t("common.add"),
            onClick: () => addItem(addInput, addBtn)
        }, uiIcon("plus", { className: "icon btn-icon" }));
        addInput.addEventListener("keydown", ev => { if (ev.key === "Enter") addItem(addInput, addBtn); });
        checklistRoot.append(h("div", { class: "check-row check-add" }, addInput, addBtn));
    }

    // Reconcile persisted state into existing rows without rebuilding the DOM.
    function syncChecklist(s) {
        const items = s.taskItems || [];
        for (const it of items) {
            const entry = checklistRows.get(it.id);
            if (!entry) continue;
            if (entry.input.checked !== !!it.completed) entry.input.checked = !!it.completed;
            entry.row.classList.toggle("done", !!it.completed);
        }
    }

    // Update only the time-dependent parts (counter, status, progress) in place.
    function updateLive(cur, { elapsed, durationCapped, estimateReached }) {
        stage.setCounter(formatClock(elapsed));
        // Written here as well as by the clock timer, so the figure is right the
        // instant the panel is built or the page comes back to the front, rather
        // than up to a second later.
        stage.setNow(Date.now());
        const extra = durationCapped
            ? t("session.maxDurationReached")
            : estimateReached ? t("session.estimateReached") : null;
        const statusText = extra
            ? `${t(`session.${cur.status}`)} · ${extra}`
            : t(`session.${cur.status}`);
        stage.setStatus(statusText);

        // The pulse follows the session's STATE, observed rather than fired: the
        // buttons below already do the work, and a change that arrived from
        // another tab or from sync has to light up the same way a local one does.
        // It is keyed off the status rather than off `estimateReached` on
        // purpose — the estimate is not a state change and it has its own signal
        // (app/session-watch.js), so nothing about the crossing is decided here.
        if (cur.status !== lastStatus) {
            lastStatus = cur.status;
            if (seen) stage.flash(cur.status);
        }
        seen = true;

        if (taskBacked) {
            const pct = Math.min(100, Math.floor((elapsed / cur.estimatedMs) * 100));
            const remaining = Math.max(0, cur.estimatedMs - elapsed);
            stage.setPercent(pct);
            elapsedValue.textContent = formatClock(elapsed);
            remainingValue.textContent = formatClock(remaining);
        } else {
            // A free session has no estimate, but the elapsed figure is still
            // true and still worth having, so the cell is shown with only one
            // figure rather than hidden behind a progress bar that cannot fill.
            elapsedValue.textContent = formatClock(elapsed);
        }
    }

    function scheduleTick() {
        if (timer) return;
        timer = setTimeout(tick, 1000);
    }

    function tick() {
        timer = null;
        const cur = live();
        const s = stats(cur);
        updateLive(cur, s);
        syncChecklist(cur);
        if (cur.status === "running") scheduleTick();
    }

    // The controls. Pause/resume first and always in the same position, because
    // they are the pair the eye reaches for and the one that has to be the same
    // button whether the session is running or stopped — a control that moves
    // when the state it acts on changes is a control to look for.
    //
    // Finish is the primary action on this screen, not pause: this is the screen
    // you opened in order to end a session, and a filled button reads as the
    // thing the page is offering. Cancel is last and danger-toned, because it
    // throws the work away rather than recording it.
    //
    // GLYPHS AND NOT WORDS, in one row at every width. They were full-width bars
    // on a phone and two rows of bars from 480px up, and a stack of bars under a
    // counter is a form: three captions for the one number the screen exists to
    // show, on the screen where that number is read from across a room. The three
    // shapes — a pause bar, a tick, a cross — are the same three the user has
    // pressed ten thousand times elsewhere, and one row of them is a third of the
    // height, so the time keeps the top of the screen. Nothing is lost to a screen
    // reader or to a mouse: each carries the word as its accessible name and its
    // tooltip, which is what `title`/`ariaLabel` are for below.
    function renderButtons(cur, durationCapped) {
        buttons.replaceChildren();
        if (cur.status === "running") {
            buttons.append(action({
                icon: "pause",
                title: t("session.pause"),
                ariaLabel: t("session.pause"),
                className: "session-control",
                onClick: () => { haptics.do("pause"); apply(() => sessionService.pause()); }
            }));
            // Once the 72 h ceiling is reached the counter stops; pause/finish
            // still work through their own button handlers.
            if (!durationCapped) scheduleTick();
        }
        if (cur.status === "paused") {
            buttons.append(action({
                icon: "play",
                title: t("session.resume"),
                ariaLabel: t("session.resume"),
                className: "session-control",
                onClick: () => { haptics.do("resume"); apply(() => sessionService.resume()); }
            }));
        }
        if (["running", "paused"].includes(cur.status)) {
            buttons.append(
                action({
                    icon: "check",
                    title: t("session.finish"),
                    ariaLabel: t("session.finish"),
                    tone: "primary",
                    className: "session-control",
                    onClick: async () => {
                        if (await dialog.confirm("session.finishConfirm")) {
                            haptics.do("finish");
                            apply(() => sessionService.finish());
                        }
                    }
                }),
                action({
                    icon: "close",
                    title: t("session.cancel"),
                    ariaLabel: t("session.cancel"),
                    tone: "danger",
                    className: "session-control",
                    onClick: async () => {
                        if (await dialog.confirm("session.cancelConfirm")) {
                            haptics.do("warn");
                            apply(() => sessionService.cancel());
                        }
                    }
                })
            );
        }
    }

    function syncNote(cur) {
        // Don't clobber the note while the user is editing it.
        if (document.activeElement !== noteInput) {
            noteInput.value = cur.note ?? "";
        }
    }

    function render() {
        const cur = live();
        // The task name is the STAGE's to draw (`setTitle`), and it is not repeated
        // here: a second copy of "running" a few lines under the first competes
        // with the number for the top of a screen that is read from a distance.
        updateLive(cur, stats(cur));

        // Rebuild the checklist only when the item set changes; otherwise sync.
        const ids = itemIds(cur);
        if (ids !== lastIds) {
            lastIds = ids;
            buildChecklist(cur);
        } else {
            syncChecklist(cur);
        }

        syncNote(cur);
        renderButtons(cur, stats(cur).durationCapped);
    }

    // The page-level subscription skips same-id sessions, so the panel watches
    // the store itself to pick up changes arriving from sync/other tabs.
    const unsub = store.subscribe(s => s.active, () => render());

    buildChecklist(session);
    render();
    document.addEventListener("visibilitychange", render);

    return {
        id: session.id,
        // Stage, then the controls under it, then the work beside or below it.
        //
        // The ORDER is the whole change. The controls used to be the last thing on
        // the page, under a checklist and a note box, which meant the two things
        // this screen exists for — the time, and the button that stops it — were a
        // full screen apart, and on a phone the button was below the fold. Now the
        // time and its controls lead, and everything read up close follows them,
        // in the order it is used: pause or resume while working, finish when done,
        // and the checklist and the note only if you want them.
        //
        // And the controls are in the STAGE'S COLUMN, not at the top of the work
        // column. Beside the timer they are read as part of it — the eye that goes
        // to the number goes straight on to the button under it — and they stay
        // where they are when the checklist scrolls, because they are inside the box
        // that sticks. In the DOM rather than by grid placement, because a control
        // that is drawn under the clock and reached after the whole checklist is a
        // keyboard trap.
        //
        // The stage carries the task name and the status, and NEITHER is repeated
        // beside it. A second copy of "running" a few lines from the first is the
        // sort of duplication this design system exists to prevent, and on a
        // display hung on a wall the second copy is the one thing competing with
        // the time for the eye.
        element: h("section", { class: "session-panel" },
            // The stage in a column of its own, because that column is what sticks.
            // A sticky element has to be its own grid item: sticky positions a box
            // inside its own containing block, so the stage wedged in as a bare
            // child of a one-column grid would travel with the whole panel and the
            // work could never scroll under it.
            h("div", { class: "session-stage" },
                stage.element,
                buttons),
            h("div", { class: "session-work" },
                card(
                    sectionTitle(t("session.details"), { icon: "info" }),
                    progress,
                    checklistRoot
                ),
                noteSection
            )
        ),
        stop() {
            if (timer) { clearTimeout(timer); timer = null; }
            // With the tick, this is what stops a session page from leaving a
            // one-second timer running on a screen nobody is looking at — the
            // panel is rebuilt on every visit to /session, and this one outlives
            // the element it is drawing into.
            clearInterval(clockTimer);
            unsub();
            document.removeEventListener("visibilitychange", render);
        }
    };
}