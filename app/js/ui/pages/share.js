import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { router } from "../../app/router.js";
import { store } from "../../app/store.js";
import { peekShare, stashShare, takeShare, hasContent, hasToken, sharePrefill } from "../../app/share-payload.js";
import { laterService } from "../../services/later-service.js";
import { sessionService } from "../../services/session-service.js";
import { readSharedShare, releaseSharedShare } from "../../services/share-intake.js";
import { MONEY_ICON_NAMES } from "../icons.js";
import { toast } from "../components/toast.js";
import { formatBytes } from "../components/attachments.js";
import { page, pageHead, card, sectionTitle, targetGrid, target, toolbar, action } from "../components/ui.js";

// The landing page for a share from the OS.
//
// A PWA manifest allows exactly one share target, and this app has four things
// a share could become: an income record, an expense, a running session, or a
// follow-up item. So the share target opens here, and this screen asks the one
// question that cannot be guessed from the payload — which of the four was it —
// with one tap of an answer and no typing at all. Every destination reads the
// parked payload and prefills itself, so the fastest path from "share" to
// "saved" is two taps and zero keystrokes.
//
// A shared FILE adds a fifth, and it comes first when there is one: a photograph
// off the camera roll is already a note, and asking a person who shared a
// receipt whether it was income or an expense before offering to keep the picture
// is a question they did not come here to answer.
//
// Nothing is written until a target is tapped. Saving straight to Later, as the
// share target used to, is right for Later and wrong for the other three:
// sharing a receipt to log it as an expense would have filed it as a link to
// follow up later.
export const sharePage = {
    title: () => t("share.title"),

    async mount(root) {
        // The payload is normally parked by main.js before the router starts. It
        // is re-stashed here so arriving at /share any other way (a bookmark, a
        // back button) still works, and so a reload of this screen still has it.
        const payload = peekShare() ?? stashShare(readFromLocation());

        // A session can only be running one at a time, so while one is live the
        // third target is not "start a session" — it is "go to the one that is
        // running". Offering to start a second one would fail on every tap.
        const active = store.getState().active;
        const live = active && ["running", "paused"].includes(active.status) ? active : null;

        // The text half of the share is drawn NOW, and the four text targets are
        // on screen before anything is fetched.
        //
        // This is the fix for a blank screen: the files come off the intake over
        // an HTTP request, and a five-megabyte clip on a phone that has just left
        // Wi-Fi is several seconds of a page that has rendered nothing at all —
        // which reads as a crash, not as a download. The text share is complete
        // and savable in that time, so it is offered in that time.
        const filesSlot = h("div", { class: "share-files-slot" });
        const preview = payload
            ? card(
                sectionTitle(t("share.shared"), { icon: "file" }),
                sharePrefill(payload, 400) ? h("p", { class: "share-preview-text" }, sharePrefill(payload, 400)) : null,
                filesSlot
            )
            : h("div", {}, filesSlot);

        const grid = targetGrid([
            target({
                name: t("share.addIncome"),
                hint: t("share.addIncomeHint"),
                icon: MONEY_ICON_NAMES.income,
                href: "/finance/transactions/new/income"
            }),
            target({
                name: t("share.addExpense"),
                hint: t("share.addExpenseHint"),
                icon: MONEY_ICON_NAMES.expense,
                href: "/finance/transactions/new/expense"
            }),
            target({
                name: live ? t("share.openSession") : t("share.startSession"),
                hint: live ? t("share.openSessionHint") : t("share.startSessionHint"),
                icon: live ? "clock" : "play",
                onClick: () => startOrOpen(live)
            }),
            target({
                name: t("share.saveLater"),
                hint: t("share.saveLaterHint"),
                icon: "bookmark",
                onClick: () => saveLater()
            })
        ]);

        const discard = action({
            label: t("share.discard"),
            icon: "close",
            onClick: () => {
                // Discarding has to clear the parked payload, not just leave
                // the screen: otherwise the same share is offered again the
                // next time /share is opened inside the TTL.
                const parked = takeShare();
                if (hasToken(parked)) releaseSharedShare(parked.token);
                router.navigate("/");
            }
        });

        root.append(page(
            pageHead({ title: t("share.title"), icon: "link" }),
            h("p", { class: "muted" }, t("share.hint")),
            preview,
            // The same target cards the home screen's money shortcuts are, at the
            // full size with a hint line. The three glyphs this screen used to
            // carry as raw path data — a clock, a play triangle and a bookmark —
            // are named in the one registry, so they are the same drawings the
            // rest of the app shows for those things.
            grid,
            toolbar(discard)
        ));

        // A share with nothing in it at all — no text, no url, and no token to go
        // and fetch — has nothing to choose from, and saying so beats four
        // buttons that all save an empty record.
        if (!payload && !hasToken(payload)) {
            filesSlot.replaceChildren(h("p", { class: "muted" }, t("share.nothingShared")));
            return;
        }

        if (!hasToken(payload)) {
            filesSlot.remove();
            return;
        }

        filesSlot.replaceChildren(h("p", { class: "muted small" }, t("share.filesLoading")));
        let shared = null;
        try {
            shared = await readSharedShare(payload.token);
        } catch (e) {
            // A failure here is NOT the end of the share: the text may still be
            // perfectly good, so the four text destinations stay and the fifth
            // simply never appears. The message says which of the three things
            // happened, because "share expired" and "the server is not configured
            // for this" are different problems with different fixes.
            toast.show(`error.${e?.code || "network"}`);
            filesSlot.replaceChildren(h("p", { class: "muted small" }, t("share.filesUnavailable")));
            takeShare();
            return;
        }
        // The chooser may have been left while the download was in flight, and
        // writing into a screen nobody is looking at is how a stale list ends up
        // in the next one.
        if (!root.isConnected) return;

        const files = shared?.files ?? [];
        if (!files.length) {
            filesSlot.replaceChildren(
                h("p", { class: "muted small" }, t("share.filesNone"))
            );
            return;
        }
        filesSlot.replaceChildren(
            filePreview(files),
            shared.dropped ? h("p", { class: "muted small" }, t("share.someFilesSkipped")) : null
        );
        // The fifth target goes FIRST, above the four: a photograph off the camera
        // roll is already a note, and asking somebody who shared a receipt whether
        // it was income or an expense before offering to keep the picture is a
        // question they did not come here to answer.
        grid.prepend(target({
            name: t("share.saveWithFiles"),
            hint: t("share.saveWithFilesHint"),
            icon: "image",
            onClick: () => saveWithFiles(files)
        }));
    }
};

// The shared files, as a row of kinds and sizes. No thumbnails: the bytes have
// just arrived over a request the browser is still finishing, and a strip of
// half-decoded images on a chooser screen is worse than a list of what is there.
function filePreview(files) {
    return h("ul", { class: "share-files" }, ...files.map(file => h("li", { class: "share-file" },
        h("span", { class: "share-file-name" }, file.name),
        h("span", { class: "muted" }, [
            t(`attachments.count${file.kind[0].toUpperCase()}${file.kind.slice(1)}`, { count: 1 }),
            " · ",
            formatBytes(file.size)
        ].join(""))
    )));
}

// Fallback for a /share visit that was not a share (a bookmark, a typo). The
// query string is only read here; the normal path parks the payload before the
// router starts, so the address bar never keeps a share to replay.
function readFromLocation() {
    if (typeof location === "undefined") return null;
    const params = new URLSearchParams(location.search);
    const raw = {
        url: (params.get("url") || "").trim(),
        text: (params.get("text") || "").trim(),
        title: (params.get("title") || "").trim(),
        // A /share?t=… address reached by hand or by a back button still names
        // the parked share, and the chooser is what turns it into a record.
        token: (params.get("t") || "").trim()
    };
    return hasContent(raw) ? raw : null;
}

// Starting a session is the fastest target of the four, so it acts immediately
// instead of opening a form: the shared title becomes the session title and the
// clock starts in the same tap. Only the two money targets need a form, because
// an amount is the one thing a share cannot supply.
async function startOrOpen(live) {
    if (live) {
        router.navigate("/session");
        return;
    }
    const payload = takeShare();
    const title = sharePrefill(payload);
    try {
        await sessionService.start({ title: title || null });
        router.navigate("/session");
    } catch (e) {
        toast.show(`error.${e?.code || "unexpected"}`);
    }
    // A shared file is not something a session can hold, so the parked share is
    // released here too: the chooser is gone and nothing is going to ask for it
    // again. The server sweeps it either way; this just does not wait ten
    // minutes to.
    if (hasToken(payload)) releaseSharedShare(payload.token);
}

async function saveLater() {
    const payload = takeShare();
    try {
        // The same parser the quick-add field uses, so a share filed from here is
        // exactly what typing it into that field would have produced.
        await laterService.createFromShare(payload ?? {});
        toast.show("later.saved");
    } catch (e) {
        toast.show(`error.${e?.code || "unexpected"}`);
    }
    if (hasToken(payload)) releaseSharedShare(payload.token);
    router.navigate("/later");
}

// A shared photograph becomes a note that IS the photograph.
//
// The text that came with the share becomes the note's text, so sharing a photo
// from a gallery app that also sent the page title produces a note with both,
// and sharing a file from a file manager produces a note named after it. The
// bytes go in through the same commit the form uses, so there is one place that
// knows how an attachment becomes stored bytes.
async function saveWithFiles(files) {
    const payload = takeShare();
    const text = sharePrefill(payload, 400);
    try {
        const { attachmentService } = await import("../../services/attachment-service.js");
        const { newDescriptor } = await import("../../domain/attachments.js");
        const at = Date.now();
        const staged = files.map(file => ({
            ...newDescriptor(file, { id: crypto.randomUUID(), now: at }),
            blob: file.blob
        }));
        const saved = await laterService.create({
            type: "note",
            title: null,
            content: text || null,
            url: null,
            attachments: staged.map(({ blob, ...descriptor }) => descriptor)
        });
        await attachmentService.commit(saved.id, staged);
        toast.show("attachments.saved");
    } catch (e) {
        toast.show(`error.${e?.code || "unexpected"}`);
    }
    if (hasToken(payload)) releaseSharedShare(payload.token);
    router.navigate("/later");
}
