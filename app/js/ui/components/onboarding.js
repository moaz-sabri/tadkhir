import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { uiIcon } from "../icons.js";
import { router } from "../../app/router.js";
import { haptics } from "../../app/haptics.js";
import { syncService } from "../../services/sync-service.js";
import * as cryptoService from "../../services/crypto-service.js";
import { authService } from "../../services/auth-service.js";
import { syncFileName, buildSyncFile, serializeSyncFile } from "../../services/sync-file.js";
import { markOnboardingSeen } from "../../app/first-run.js";
import { page, action, toolbar, heading, pickRow, listRow } from "./ui.js";
import { field, fieldError } from "./fields.js";
import { dialog } from "./dialog.js";
import { toast } from "./toast.js";

// The word the skip warning asks to be typed.
//
// "OK" rather than a word from the interface language, and that is deliberate:
// the dialog is shown in one of two languages, and a word the reader has to look
// up in a language that is not the one they are reading would be an obstacle
// rather than a confirmation. It is also the word a warning like this is expected
// to ask for, so the act reads correctly without a line of instructions saying so.
const CONFIRM_WORD = "ok";

// The first-run flow: a welcome, a decision about access, and — only for
// somebody who just made a key rather than attached one — a short look at what
// the app does.
//
// WHY IT IS NOT A ROUTE. It is not a destination, it cannot be linked to, and it
// has no place in the navigation. A route would also have needed an entry in the
// nav table and an icon, which is precisely wrong: the thing a person sees once
// on the way in should not become a tab they can return to. So it renders into
// #app over the shell and resolves when the user is through, at which point
// main.js starts the router. The cost is that it has to draw itself, because no
// page is going to draw it.
//
// THE FOUR SCREENS, and what each one is for:
//
//   welcome  — what this is. One sentence and a button.
//   access   — the only screen with a decision in it.
//   create   — password + owner number, for a device making its own key
//   brief    — one line per section, for somebody who has just been given a
//              password form and has no idea what they are being set up for
//
// Somebody who attaches an existing key skips create AND brief and lands in the
// app. They already know what Tadkhir is — they are using it on another
// device — and showing them a tour of features they have already used is the
// slowest possible way to let them back in.
//
// Skippable, but never quietly.
//
// The app runs without a key: tasks, sessions and finance all work on this device
// alone. What they do NOT have is a second copy, sync, or encryption — the records
// are stored in the clear, so clearing this browser's data or losing this phone
// takes all of it and gives nothing back. So the way past the key exists, it is
// behind a warning that states those four consequences as checkable facts, and it
// asks for a word to be typed before it lets go.
//
// And it saves nothing. A skip is a way to look at the app now, not a decision to
// leave the key behind, so the flag is not written and the question comes back
// next time — which the warning says out loud, because a choice the user believes
// was remembered and was not is the worse failure of the two.
const MIN_PASSWORD_LENGTH = 8;
const MIN_OWNER_LENGTH = 6;

// The sections, in the order they appear in the navigation. One line each: the
// point of this screen is that a person who has never seen the app leaves knowing
// what the eight destinations are FOR, not what they are called.
const BRIEF_SECTIONS = [
    ["clock", "briefSessions", "briefSessionsHint"],
    ["tasks", "briefTasks", "briefTasksHint"],
    ["bookmark", "briefLater", "briefLaterHint"],
    ["file", "briefPages", "briefPagesHint"],
    ["wallet", "briefFinance", "briefFinanceHint"],
    ["chart", "briefReports", "briefReportsHint"],
    ["sliders", "briefSettings", "briefSettingsHint"]
];

// `onDone` is called after the router has started, and is what boots the parts
// of the app that need a mounted page. It is a parameter rather than something
// this module reaches for, because the flow is otherwise self-contained: it
// draws into a root it is handed and starts the router, and everything else is
// main.js's business.
export function runOnboarding(root, onDone) {
    // A single mounted node, rebuilt per step. Steps are four short forms and a
    // list, and rebuilding the subtree per step keeps each one readable on its
    // own terms — where a growing chain of show/hide flags would make "which
    // parts of this screen are showing" a question about eleven booleans.
    const shell = h("div", { class: "onboarding" });
    root.replaceChildren(shell);

    // The app's own chrome is hidden for the duration.
    //
    // The navigation is empty here — the router has not started, so there is no
    // current page for it to mark — and an empty navigation next to a welcome
    // screen is worse than none: it is a visible piece of an app that has not
    // been set up yet. The class is on <body> rather than on a wrapper because
    // the header and the add button are siblings of #app and cannot be
    // reached from inside it, and it is taken off on the way out so a screen
    // that somehow failed to finish does not leave the app headless.
    document.body.classList.add("is-onboarding");
    const dropChrome = () => document.body.classList.remove("is-onboarding");

    // One place that leaves the flow, so every exit goes through it and the flag
    // is written in exactly one of them.
    //
    // `remember` is the whole of the skip policy, and it is a parameter rather
    // than a branch somewhere else so that the difference is visible at the call
    // site: finishing or attaching a key REMEMBERS, skipping does NOT. A skip is
    // a way to look at the app now, not a decision to leave the key behind — so
    // nothing is written to the database, and the flow is asked again next time.
    // The warning says exactly that, because a choice the user believes was saved
    // and was not is worse than one they knew was temporary.
    let left = false;
    const leave = async ({ remember = true } = {}) => {
        if (left) return;
        left = true;
        // The chrome comes back BEFORE the router starts, because the router's
        // first navigation is what fills the navigation in — a frame with the
        // header restored and the bar still empty is visible on slow devices.
        dropChrome();
        if (remember) {
            try { await markOnboardingSeen(); } catch (e) { console.warn("Could not record onboarding", e); }
        }
        await router.start();
        onDone?.();
    };

    const back = (to) => action({
        label: t("onboarding.back"),
        icon: "back",
        tone: "quiet",
        className: "ob-back",
        onClick: to
    });

    // The way past the key, and the only screen in this app that can talk a
    // person out of a decision they are about to make.
    //
    // It is a typed confirmation rather than a plain dialog for three reasons,
    // each of which is a fact about the person in front of it: the tap that opens
    // it is a reflex, not a decision, so the first screen has to slow them down;
    // the consequences are severe enough and quiet enough that a glance is not
    // enough; and the one thing being asked for is an irreversible outcome —
    // data with no second copy — where a mis-tap must not be the whole of it.
    //
    // Every line in the dialog is a verifiable fact, not a caution. "You might
    // lose data" cannot be checked and is not read; four specific consequences can
    // be checked against the screen behind this one, and that is what makes
    // somebody stop and decide rather than dismiss.
    const skipAction = () => action({
        label: t("onboarding.accessSkip"),
        icon: null,
        tone: "quiet",
        onClick: () => warnAboutSkipping()
    });

    async function warnAboutSkipping() {
        let input = null;
        let err = null;

        const answer = await dialog.form(null, {
            titleKey: "onboarding.skipTitle",
            submitLabel: "onboarding.skipConfirm",
            submitIcon: "warning",
            body: () => [
                h("p", { class: "dialog-warning" }, t("onboarding.skipWarnNone")),
                h("p", { class: "muted" }, t("onboarding.skipWarnOne")),
                h("p", { class: "muted" }, t("onboarding.skipWarnNoSync")),
                h("p", { class: "dialog-warning" }, t("onboarding.skipWarnLoss")),
                h("p", { class: "muted small" }, t("onboarding.skipLater")),
                h("p", { class: "muted small" }, t("onboarding.skipNotRemembered")),
                field(
                    t("onboarding.skipConfirmLabel"),
                    input = h("input", {
                        type: "text",
                        autocomplete: "off",
                        autocapitalize: "characters",
                        spellcheck: false
                    })
                ),
                err = h("p", { class: "dialog-error", hidden: true })
            ],
            submit: close => {
                // Case-insensitive, because the word is typed on a phone keyboard
                // that will happily capitalise the first letter on its own — and a
                // check that rejects "ok" for the keyboard's behaviour teaches the
                // user that the warning is a trick rather than a warning.
                if (input.value.trim().toLowerCase() !== CONFIRM_WORD) {
                    err.textContent = t("onboarding.skipConfirmWrong");
                    err.hidden = false;
                    input.focus();
                    return;
                }
                close(true);
            }
        });

        // Dismissed, or the dialog was replaced by a navigation. Either way the
        // flow is exactly where it was.
        if (answer === dialog.CANCELLED || !answer) return;
        // Nothing is remembered. See the note on leave().
        await leave({ remember: false });
    }

    // One flag for every step, declared before any of them, because a form that is
    // still submitting has to refuse a second submit and the import path has to
    // refuse a second attempt inside its retry loop — and neither of them can see
    // the other's state.
    let busy = false;

    // ------------------------------------------------------------------ 1 ---

    function showWelcome() {
        shell.replaceChildren(page(
            h("div", { class: "ob-hero" },
                h("img", {
                    class: "ob-mark",
                    src: "/icons/icon-512.svg",
                    alt: "",
                    width: "72",
                    height: "72"
                }),
                heading(t("onboarding.welcomeTitle"), { tag: "h1" }),
                h("p", { class: "ob-lead" }, t("onboarding.welcomeLead")),
                h("p", { class: "muted" }, t("onboarding.welcomeBody"))
            ),
            h("div", { class: "ob-actions" },
                action({ label: t("onboarding.welcomeStart"), icon: "play", tone: "primary", onClick: showAccess }),
                action({ label: t("onboarding.welcomeSkip"), icon: null, tone: "quiet", onClick: () => warnAboutSkipping() })
            )
        ));
        // Nothing is auto-focused: the first screen has one obvious action and
        // moving focus onto it invites an accidental Enter.
    }

    // ------------------------------------------------------------------ 2 ---

    // Two options, each one whole row.
    //
    // pickRow rather than listRow, and the difference matters: pickRow's whole
    // line is the button, so the target is the full width of the row instead of
    // the 44px square a trailing row action gets. On a phone, with two options
    // and one of them leading to a form, that is the difference between a tap
    // you can make and a tap you have to aim.
    function showAccess() {
        shell.replaceChildren(page(
            back(showWelcome),
            heading(t("onboarding.accessTitle")),
            h("p", { class: "muted" }, t("onboarding.accessLead")),
            h("div", { class: "list" },
                pickRow({
                    icon: "lock",
                    title: t("onboarding.accessCreate"),
                    subtitle: t("onboarding.accessCreateHint"),
                    onClick: showCreate
                }),
                pickRow({
                    icon: "upload",
                    title: t("onboarding.accessImport"),
                    subtitle: t("onboarding.accessImportHint"),
                    onClick: showImport
                })
            ),
            h("div", { class: "ob-actions" }, skipAction())
        ));
    }

    // ------------------------------------------------------- 2a — new key ----

    function showCreate() {
        let pass = null;
        let pass2 = null;
        let owner = null;
        let err = fieldError("ob-create-error");
        const submit = action({
            label: t("onboarding.createSubmit"),
            icon: "lock",
            type: "submit",
            tone: "primary"
        });

        // The owner's one number, shown with its rule rather than a bare label:
        // it is the only field here whose purpose is not obvious from its name,
        // and it is the one a person cannot recover if they forget it.
        const ownerField = field(
            t("onboarding.createOwner"),
            owner = h("input", { type: "password", placeholder: "••••••••", autocomplete: "off" }),
            null,
            h("p", { class: "muted small" }, t("onboarding.createOwnerHint", { n: MIN_OWNER_LENGTH }))
        );

        // One warning, inside the form, next to the fields it is about — and it
        // replaces the lead paragraph rather than repeating it. The same sentence
        // twice, once grey and once red, is how a two-line form turns into a
        // five-line one.
        const form = h("form", { class: "form", noValidate: true },
            h("p", { class: "dialog-warning" }, t("onboarding.createLead")),
            field(t("onboarding.createPassword"),
                pass = h("input", { type: "password", placeholder: "••••••••", autocomplete: "new-password" })),
            field(t("onboarding.createConfirm"),
                pass2 = h("input", { type: "password", placeholder: "••••••••", autocomplete: "new-password" })),
            ownerField,
            err,
            h("div", { class: "form-actions" }, submit)
        );

        // Validated here rather than by the service, because these two rules are
        // about the form being readable: an 8-character password and two matching
        // ones are things the person can be told before anything is written, where
        // a failure after the write is a password the device may already have
        // stored. The service re-checks the password by decrypting, which is a
        // different question and still runs.
        const say = message => { err.textContent = message; };

        form.addEventListener("submit", async e => {
            e.preventDefault();
            if (busy) return;
            if (pass.value.length < MIN_PASSWORD_LENGTH) {
                say(t("error.password_too_short"));
                pass.focus();
                return;
            }
            if (pass.value !== pass2.value) {
                say(t("error.password_mismatch"));
                pass2.focus();
                return;
            }
            if (owner.value.trim().length < MIN_OWNER_LENGTH) {
                say(t("error.owner_code_short"));
                owner.focus();
                return;
            }
            busy = true;
            submit.disabled = true;
            say("");
            try {
                const res = await syncService.createKey({
                    password: pass.value,
                    ownerCode: owner.value.trim()
                });
                if (!res.ok) { say(t(`error.${res.code || "unexpected"}`)); return; }
                haptics.do("start");
                showCreated(res.code);
            } catch (e2) {
                say(t(`error.${e2?.code || "unexpected"}`));
            } finally {
                busy = false;
                submit.disabled = false;
            }
        });

        shell.replaceChildren(page(
            back(showAccess),
            heading(t("onboarding.createTitle")),
            form
        ));
        pass.focus();
    }

    // The key exists; hand the user the file that is the only other way in.
    // Without this the key is a fact on one device with no copy anywhere, and a
    // person who finds out that the hard way has lost their account — so it is a
    // screen of its own rather than a toast that disappears.
    //
    // Forward only, like the screen after it, and for the same reason: there is
    // nothing to go back to that is safe. A Back here would lead to a device that
    // already has a key being offered a second one, and a second key replaces the
    // first — which would invalidate the file this screen is asking them to save.
    function showCreated(code) {
        // The one screen in the flow that is centred like the welcome screen,
        // because it is the other moment that is not a form: the key exists, and
        // there is one thing left to say about it. Centring it reads as a
        // checkpoint between two questions rather than as a third question.
        shell.replaceChildren(h("div", { class: "ob-hero" },
            h("span", { class: "empty-icon" }, uiIcon("check")),
            heading(t("onboarding.createdTitle"), { tag: "h1" }),
            h("p", { class: "muted" }, t("onboarding.createdBody")),
            h("p", { class: "muted small ob-code" }, t("onboarding.createdCode", { code: code || "—" }))
        ));
        shell.append(h("div", { class: "ob-actions" },
            action({
                label: t("onboarding.createdDownload"),
                icon: "download",
                onClick: () => downloadKeyFile()
            }),
            action({
                label: t("onboarding.createdContinue"),
                icon: "check",
                tone: "primary",
                onClick: showBrief
            })
        ));
    }
    // The file is built from what the service just created rather than re-exported
    // through exportSyncFile(), which would ask for the password a second time —
    // on a first-run screen, immediately after the person typed it.
    async function downloadKeyFile() {
        try {
            const cfg = await syncService.getConfig();
            const encryptedKey = await cryptoService.getEncryptedKey();
            const owner = await authService.getOwnerVerifier();
            if (!cfg.code || !encryptedKey) { toast.show("error.no_encrypted_key"); return; }
            const json = serializeSyncFile(buildSyncFile({
                code: cfg.code,
                encryptedPayload: encryptedKey,
                owner
            }));
            if (json == null) { toast.show("error.sync_invalid"); return; }
            const url = URL.createObjectURL(new Blob([json], { type: "application/octet-stream" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = syncFileName();
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            toast.show(`error.${e?.code || "unexpected"}`);
        }
    }

    // ---------------------------------------------------- 2b — attach a key --

    function showImport() {
        // Held here rather than re-read per attempt: a file is read from disk
        // once, and the password is entered on the screen that follows, so both
        // outlive a failed attempt. Clearing them on failure would make a mistyped
        // password cost the user the file too.
        let fileText = null;
        let pass = null;
        let owner = null;
        let err = fieldError("ob-import-error");
        const fileInput = h("input", {
            type: "file",
            accept: ".enc,.sync.enc,application/octet-stream,.json,application/json",
            class: "sr-only"
        });
        const submit = action({
            label: t("onboarding.importSubmit"),
            icon: "link",
            type: "submit",
            tone: "primary",
            disabled: true
        });
        const chosen = h("p", { class: "muted small" });

        const say = message => { err.textContent = message; };

        fileInput.addEventListener("change", async () => {
            const f = fileInput.files?.[0];
            if (!f) return;
            try {
                fileText = await f.text();
                chosen.textContent = f.name;
                submit.disabled = false;
                say("");
                pass.focus();
            } catch (e) {
                fileText = null;
                submit.disabled = true;
                say(t("error.sync_invalid"));
            }
        });

        const form = h("form", { class: "form", noValidate: true },
            h("p", { class: "muted" }, t("onboarding.importLead")),
            toolbar(
                action({
                    label: t("onboarding.importPick"),
                    icon: "upload",
                    onClick: () => fileInput.click()
                }),
                chosen
            ),
            fileInput,
            field(t("onboarding.importPassword"),
                pass = h("input", { type: "password", placeholder: "••••••••", autocomplete: "current-password" })),
            field(t("onboarding.importOwner"),
                owner = h("input", { type: "password", placeholder: "••••••••", autocomplete: "off" })),
            err,
            h("div", { class: "form-actions" }, submit)
        );

        // The same two-step shape as Settings' import, for the same reasons: the
        // owner number is asked for once and the service re-checks it against the
        // file's own verifier, and a rejected attempt keeps both fields so a
        // mistyped password is one correction rather than a restart.
        //
        // A cross-space answer means this device already has a DIFFERENT key. The
        // service has already proved the file opens before saying so, so the only
        // remaining question is whether to replace what is here.
        form.addEventListener("submit", async e => {
            e.preventDefault();
            if (busy) return;
            if (fileText == null) { say(t("onboarding.importNoFile")); return; }
            if (!pass.value) { say(t("error.password_required")); pass.focus(); return; }
            if (owner.value.trim().length < MIN_OWNER_LENGTH) {
                say(t("error.owner_code_short"));
                owner.focus();
                return;
            }
            busy = true;
            submit.disabled = true;
            say("");
            try {
                for (;;) {
                    const res = await syncService.importSyncFile(fileText, {
                        password: pass.value,
                        ownerCode: owner.value.trim()
                    });
                    if (res.ok && res.requiresAction === "cross_space") {
                        const proceed = await dialog.confirm("settings.syncCrossSpaceConfirm");
                        if (!proceed) return;
                        await syncService.clearConfig();
                        await cryptoService.clearEncryptionKeys();
                        continue;
                    }
                    if (!res.ok) { say(t(`error.${res.code || "unexpected"}`)); return; }
                    haptics.do("start");
                    toast.show("settings.syncFileImported");
                    // Straight to the app: somebody who attached a key already
                    // uses this app somewhere else, and has no need of the tour.
                    return leave();
                }
            } catch (e2) {
                say(t(`error.${e2?.code || "unexpected"}`));
            } finally {
                busy = false;
                submit.disabled = false;
            }
        });

        shell.replaceChildren(page(
            back(showAccess),
            heading(t("onboarding.importTitle")),
            form
        ));
    }

    // ------------------------------------------------------------------ 3 ---

    // The one screen after the key exists, and the only one in the flow that goes
    // FORWARD only. There is no Back here, and that is a safety property rather
    // than a simplification: going back would offer "create a new key" to a device
    // that already has one, and creating a second key generates a new master key
    // over the old one — which would quietly invalidate the key file the person was
    // just told to save, and with it their only way back to this data.
    function showBrief() {
        shell.replaceChildren(page(
            heading(t("onboarding.briefTitle")),
            h("p", { class: "muted" }, t("onboarding.briefLead")),
            h("div", { class: "list" },
                ...BRIEF_SECTIONS.map(([icon, titleKey, hintKey]) => listRow({
                    icon,
                    title: t(`onboarding.${titleKey}`),
                    subtitle: t(`onboarding.${hintKey}`)
                }))
            ),
            h("div", { class: "ob-actions ob-actions-pinned" },
                action({
                    label: t("onboarding.briefStart"),
                    icon: "check",
                    tone: "primary",
                    onClick: () => leave()
                })
            )
        ));
    }

    // A window closed, a tab discarded, a crash in a step: the class has to come
    // off, or the next load of this same profile opens an app with no header and
    // no navigation and no way back. `pagehide` fires for both a navigation and a
    // bfcache eviction, which are the only two ways out of here other than
    // `leave()`.
    window.addEventListener("pagehide", dropChrome, { once: true });

    showWelcome();
    return shell;
}