import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { router } from "../../app/router.js";
import { laterService } from "../../services/later-service.js";
import { attachmentService } from "../../services/attachment-service.js";
import { isMediaLed, leadPhoto } from "../components/attachments.js";
import { bus } from "../../app/bus.js";
import { laterForm } from "../components/later-form.js";
import { laterRow } from "../components/later-row.js";
import { toast } from "../components/toast.js";
import { dialog } from "../components/dialog.js";
import { kanbanService } from "../../services/kanban-service.js";
import { haptics } from "../../app/haptics.js";
import {
    page,
    pageHead,
    pageSection,
    list,
    emptyState,
    action,
    backTo,
    toolbar,
    notFoundView
} from "../components/ui.js";

const BASE = "/later";

// The list.
//
// Two lists, not one: what still needs a decision, and what has been followed
// up. The second one is only rendered when it has something in it, so a user who
// never follows anything up does not see a permanently empty section.
//
// ONE DOOR. There was a second one here — a quick field with three capture
// buttons, sitting above this list — and it is gone.
//
// It was not removed because it was ugly, and not because the fix is hard: it
// was removed because it was the second copy of everything, and two copies of a
// save path means one of them rots in silence. Concretely, in the rounds leading
// up to this: the recorder's `InvalidStateError` was fixed in `recorder.js` and
// nobody came back to check this screen, which reaches the same recorder through
// a different call; `entry.blob = blob` in the attachments section — the line
// that decides whether saved bytes are ever drawn — had no behavioural test for
// three years, and a quick add has no place to show a blob it never received.
// A defect here is invisible from inside the app: the item appears not to save,
// and the other door still works perfectly, so the fault reads as the user's.
//
// So everything now enters through `newLater` below, which creates the item and
// lands on its own screen — so the very next thing available is renaming it,
// adding a second photo, or deleting it. A "saved!" toast and a row somewhere
// else would leave the person with a record they cannot reach, and a second
// door that fails quietly would leave them with no record at all.
export const laterPage = {
    title: () => t("later.title"),

    async mount(root) {
        const openBox = h("div", { class: "list" });
        const doneBox = h("div", { class: "list" });
        const doneSection = pageSection({
            title: t("later.doneList"),
            icon: "check",
            body: doneBox,
            hidden: true
        });
        const openSection = pageSection({
            title: t("later.openList"),
            icon: "bookmark",
            body: openBox
        });

        root.append(page(
            pageHead({
                title: t("later.title"),
                icon: "bookmark",
                actions: action({ label: t("later.new"), icon: "plus", tone: "primary", href: `${BASE}/new` })
            }),
            h("p", { class: "muted" }, t("later.hint")),
            openSection
        ));

        // The object URLs of the thumbnails this list is drawing, revoked on every
        // re-render. A `blob:` URL holds its photograph alive for the life of the
        // document, and this list re-renders on every follow-up, every delete and
        // every sync, so without this a screen left open would pin one copy of
        // every picture it had ever drawn.
        let thumbs = new Map();
        // Which load is current. `loadThumbs` awaits IndexedDB, and a re-render
        // can start while the previous one is still waiting — the router's own
        // generation guard only covers whole pages, not two renders of the same
        // one. Without this the slower load finished last and ran
        // `releaseThumbs(itsOwn)`, revoking the URLs the newer render had just
        // created and were drawing: `net::ERR_FILE_NOT_FOUND` on a `blob:` that
        // was correct ten milliseconds earlier.
        let thumbRun = 0;

        // Called only by the run that owns `thumbs` (loadThumbs checks its own
        // generation first) and by unmount, so it does not re-check: the guard
        // lives where the staleness is, not here where it cannot be seen.
        const releaseThumbs = keep => {
            for (const [id, url] of thumbs) {
                if (keep.has(id)) continue;
                URL.revokeObjectURL(url);
            }
            thumbs = keep;
        };

        /**
         * The picture for each row that should show one.
         *
         * A row's record carries the DESCRIPTION of its attachments and not the
         * bytes, so a thumbnail has to be fetched — one IndexedDB read per
         * media-led row, and only for those. A row whose bytes are not on this
         * device gets none, and the row falls back to the glyph: an empty frame
         * where a picture should be would be worse than a glyph, because it looks
         * like the picture failed to load rather than like it was never here.
         */
        const loadThumbs = async items => {
            const run = ++thumbRun;
            const keep = new Map();
            const made = [];
            await Promise.all(items.map(async item => {
                if (!isMediaLed(item)) return;
                const photo = leadPhoto(item);
                if (!photo) return;
                // A URL already made for this item is reused rather than remade:
                // re-decoding every photograph on every re-render is the cost this
                // cache exists to avoid. Read BEFORE the await, so the map this
                // run started from is the one it reasons about.
                const existing = thumbs.get(item.id);
                if (existing) {
                    keep.set(item.id, existing);
                    return;
                }
                const blob = await attachmentService.blobOf(item.id, photo.id)
                    .catch(() => null);
                if (!blob) return;
                if (run !== thumbRun) return;   // superseded: do not make a URL
                const url = URL.createObjectURL(blob);
                made.push(url);
                keep.set(item.id, url);
            }));

            // A newer render started while this one was waiting. Everything this
            // run created is dropped on the floor — revoked, not returned — so it
            // cannot outlive the rows that were going to draw it.
            if (run !== thumbRun) {
                for (const url of made) URL.revokeObjectURL(url);
                return thumbs;
            }
            releaseThumbs(keep);
            return keep;
        };

        const render = async () => {
            const { open, done } = await laterService.list();
            const thumbsById = await loadThumbs([...open, ...done]);

            // Which of these are already on the board. Read once per render rather
            // than per row: the board is one store, and asking it four times for
            // four rows is four transactions to learn one fact.
            const onBoard = new Set(
                (await Promise.all(
                    [...open, ...done].map(item =>
                        kanbanService.has(`later:${item.id}`).then(yes => (yes ? item.id : null))
                    )
                )).filter(Boolean)
            );

            // The open list is either rows or the empty state, never both: two
            // empty states could not both be true, and the one here used to be
            // rendered inside the list while the section title stayed above it.
            if (open.length === 0) {
                openBox.replaceChildren(emptyState(t("later.empty"), {
                    icon: "bookmark",
                    action: action({ label: t("later.new"), icon: "plus", tone: "primary", href: `${BASE}/new` })
                }));
            } else {
                openBox.replaceChildren(list(...open.map(item => laterRow(item, {
                    thumbUrl: thumbsById.get(item.id) ?? null,
                    onDone: () => setDone(item, true),
                    onDelete: () => remove(item),
                    onAddToBoard: onBoard.has(item.id) ? null : () => addToBoard(item)
                }))));
            }

            doneBox.replaceChildren(list(...done.map(item => laterRow(item, {
                thumbUrl: thumbsById.get(item.id) ?? null,
                onDone: () => setDone(item, false),
                onDelete: () => remove(item)
            }))));
            doneSection.hidden = done.length === 0;
            root.append(doneSection);
        };

        // Leaving the screen gives the URLs back rather than waiting for the next
        // re-render, which may be a long time on a screen nobody is looking at.
        //
        // AND ONLY A ROUTE THAT ACTUALLY TOOK THIS SCREEN AWAY. The router emits
        // "route" at the END of every navigate() — including the navigation that
        // mounted this page — so a handler that released unconditionally revoked
        // the very URLs the rows it had just finished drawing were loading. The
        // result was a list whose thumbnails were blank and `net::
        // ERR_FILE_NOT_FOUND` on a blob URL that was correct a moment earlier: the
        // row said the photo was there and showed an empty frame where it was.
        //
        // `root.isConnected` is the question that matters, and it is the same
        // question the attachment section asks: the router replaces #app's children
        // with the new view, so the moment this screen is really gone, this node is
        // detached. During the mount that created these URLs it is still connected,
        // and nothing is revoked out from under the rows drawing it.
        const offRoute = bus.on("route", () => {
            if (!root.isConnected) releaseThumbs(new Map());
        });

        const setDone = async (item, done) => {
            try {
                await laterService.setCompleted(item.id, done);
                await render();
            } catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
        };

        const remove = async item => {
            if (!await dialog.confirm("later.deleteConfirm")) return;
            try {
                // laterService.remove also takes the board's card off the board, so
                // deleting an item cannot leave a card pointing at nothing.
                await laterService.remove(item.id);
                await render();
            } catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
        };

        // The one door into the board from a Later list. The item itself is not
        // touched and not copied: what is added is a pointer, and the card reads
        // its label from this record whenever the board is drawn.
        const addToBoard = async item => {
            try {
                await kanbanService.addFromOriginal(item, { service: "later" });
                haptics.do("ack");
                toast.show("kanban.added");
                await render();
            } catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
        };

        // Read by unmount() below. A page holds its teardown here rather than
        // returning it, because the router calls `page.unmount()` and ignores
        // whatever `mount()` returned.
        laterPage.releaseThumbs = () => {
            offRoute();
            // Bumped as well as emptied: a load still waiting on IndexedDB must
            // not put its URLs back into a map the screen has already given up.
            thumbRun++;
            releaseThumbs(new Map());
        };

        await render();
    },

    // The object URLs go back when the screen is left rather than waiting for
    // the next re-render, which on a screen nobody is looking at may be a long
    // time — and a `blob:` URL holds its photograph for the life of the document.
    unmount() {
        laterPage.releaseThumbs?.();
        laterPage.releaseThumbs = null;
    }
};

// The ONE way an item is created from inside the app: a title, or a url typed
// out rather than pasted, plus the four adders for a photo, a voice memo, a
// video or a file.
//
// It saves and then leaves, and that order is deliberate. It lands the person on
// the item's own screen, where the next thing available is renaming it, adding a
// second photo, or deleting it. Anything else — a toast, a row appearing
// somewhere up the list — puts the record out of reach of the person who just
// made it, and on this screen that failure is indistinguishable from not having
// saved at all.
export const newLater = {
    title: () => t("later.new"),

    async mount(root) {
        root.append(page(
            pageHead({
                title: t("later.new"),
                icon: "plus",
                leading: backTo(BASE)
            }),
            laterForm(null, async (patch, files) => {
                try {
                    // Two writes, and the order is not arbitrary: the record
                    // exists before the bytes are written to it, because a blob
                    // with no record describing it is invisible storage while a
                    // record describing a blob that is not there is a broken
                    // attachment the user cannot get rid of.
                    const saved = await laterService.create(patch);
                    await attachmentService.commit(saved.id, files ?? []);
                    router.navigate(BASE);
                } catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
            })
        ));
    }
};

// Reading and editing one item: the same form, filled in, plus the one action
// that only makes sense on a single item — following it up.
export const laterDetail = {
    title: () => t("later.edit"),

    async mount(root, params) {
        let item;
        try {
            item = await laterService.get(params.id);
        } catch {
            item = null;
        }
        if (!item) {
            notFoundView(root);
            return;
        }
        const form = laterForm(item, async (patch, files) => {
            try {
                // The record first, then the bytes it describes — see the note
                // on the new-item form above. `commit` also drops the bytes of any
                // attachment the form removed, so a removal is not a second
                // operation the caller has to remember.
                await laterService.update(item.id, patch);
                await attachmentService.commit(item.id, files ?? []);
                router.refresh();
            } catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
        });

        root.append(page(
            pageHead({
                title: t("later.edit"),
                icon: item.type === "link" ? "link" : "note",
                leading: backTo(BASE),
                actions: item.type === "link"
                    ? action({ label: t("later.openLink"), icon: "external", href: item.url, external: true })
                    : null
            }),
            pageSection({ body: form }),
            toolbar(
                action({
                    label: item.completedAt ? t("later.reopen") : t("later.markDone"),
                    icon: item.completedAt ? "undo" : "check",
                    onClick: async () => {
                        try {
                            await laterService.setCompleted(item.id, !item.completedAt);
                            router.navigate(BASE);
                        } catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
                    }
                }),
                action({
                    label: t("common.delete"),
                    icon: "trash",
                    tone: "danger",
                    onClick: async () => {
                        if (!await dialog.confirm("later.deleteConfirm")) return;
                        try {
                            await laterService.remove(item.id);
                            router.navigate(BASE);
                        } catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
                    }
                })
            )
        ));
    }
};

// The OS share sheet no longer lands here. The manifest's single share target
// now points at /share, where a chooser asks whether the shared content is an
// income record, an expense, a session, or a follow-up item — filing it here
// unconditionally was right for a link and wrong for the other three. The share
// that does become a follow-up item is written from share.js through
// laterService.createFromShare, i.e. through exactly this service.
