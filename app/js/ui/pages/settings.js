import { h } from "../dom.js";
import { t, setLanguage, getLanguage } from "../../i18n/i18n.js";
import { APP_VERSION } from "../../config.js";
import { router } from "../../app/router.js";
import { store } from "../../app/store.js";
import { backupService } from "../../services/backup-service.js";
import { syncService } from "../../services/sync-service.js";
import * as cryptoService from "../../services/crypto-service.js";
import { authService } from "../../services/auth-service.js";
import { attachmentService } from "../../services/attachment-service.js";
import { haptics } from "../../app/haptics.js";
import { notifications } from "../../app/notifications.js";
import { captureAvailability, permissionState, requestCapturePermission } from "../../app/capture.js";
import { wakeLock } from "../../app/wake-lock.js";
import { canInstall, promptInstall } from "../../app/sw-register.js";
import { dialog } from "../components/dialog.js";
import { toast } from "../components/toast.js";
import { page, pageHead, pageSection, card, action, toolbar, listRow } from "../components/ui.js";
import { field, selectControl, settingRow, toggleRow } from "../components/fields.js";
import { formatBytes } from "../components/attachments.js";

const MIN_OWNER_LENGTH = 6;

// The three prompts below are small forms, not questions, so they go through
// dialog.form: one lifecycle, which means all three now close on Escape, on the
// backdrop and on a navigation. They used to be hand-rolled promises with none of
// those, so a keyboard-only user could not cancel one at all and had to Tab to
// the Cancel button — they were the only modals in the app with no exit that was
// not a pointer.
//
// Each resolves with the entered value, or with dialog.CANCELLED if dismissed.
// A dismissal and a field left empty both mean "do not proceed", so the prompts
// normalise the sentinel to null here and the call sites keep reading
// `if (password == null) return`.
const orNull = pending => pending.then(v => (v === dialog.CANCELLED ? null : v));

// Verifies an EXISTING password before an export/import proceeds.
function promptExistingPassword(code = null, action = "export") {
    const hintKey = action === "import" ? "settings.syncFilePasswordHint" : "settings.syncFileExportHint";
    const message = t(hintKey) + (code ? ` — ${t("settings.syncFilePasswordSpace", { code })}` : "");
    let input = null;
    return orNull(dialog.form(message, {
        titleKey: action === "import" ? "settings.syncFilePasswordTitle" : "settings.syncFileExportTitle",
        submitLabel: "common.confirm",
        submitIcon: "lock",
        body: () => field(t("settings.syncPassword"),
            input = h("input", { type: "password", placeholder: "••••••••", autocomplete: "current-password" })),
        submit: close => close(input.value || null)
    }));
}

// Creates a NEW password when the device has none yet: entered twice to confirm,
// with a clear warning that a lost password cannot be recovered or reset.
function promptCreatePassword({ code = null, hintKey = "settings.createPasswordHint" } = {}) {
    let pass = null, pass2 = null, err = null;
    const say = text => {
        err.textContent = text;
        err.hidden = false;
    };
    return orNull(dialog.form(t(hintKey), {
        titleKey: "settings.createPasswordTitle",
        submitLabel: "common.confirm",
        submitIcon: "lock",
        body: () => [
            h("p", { class: "dialog-warning" }, t("settings.passwordLossWarning")),
            ...(code ? [h("p", { class: "muted small" }, t("settings.syncFilePasswordSpace", { code }))] : []),
            field(t("settings.syncPassword"),
                pass = h("input", { type: "password", placeholder: "••••••••", autocomplete: "new-password" })),
            field(t("settings.confirmPassword"),
                pass2 = h("input", { type: "password", placeholder: t("settings.confirmPassword"), autocomplete: "new-password" })),
            err = h("p", { class: "dialog-error", hidden: true })
        ],
        // A failed check leaves the dialog open with the reason beside the field,
        // instead of closing and taking the two typed passwords with it.
        submit: close => {
            if (pass.value.length < 8) {
                say(t("error.password_too_short"));
                pass.focus();
                return;
            }
            if (pass.value !== pass2.value) {
                say(t("error.password_mismatch"));
                pass2.focus();
                return;
            }
            close(pass.value);
        }
    }));
}

// Asks for the owner secret number: set ONCE on the first export/import, never
// changes afterwards. On later exports/imports the same number must be re-entered
// to prove ownership (a file with its password belongs to one owner only).
function promptOwnerCode({ code = null, isNew = false } = {}) {
    const message = t(isNew ? "settings.ownerCodeNewHint" : "settings.ownerCodeHint")
        + (code ? ` — ${t("settings.syncFilePasswordSpace", { code })}` : "");
    let owner = null, err = null;
    return orNull(dialog.form(message, {
        titleKey: "settings.ownerCodeTitle",
        submitLabel: "common.confirm",
        submitIcon: "lock",
        body: () => [
            ...(code ? [h("p", { class: "muted small" }, t("settings.syncFilePasswordSpace", { code }))] : []),
            field(t("settings.ownerCodeLabel"),
                owner = h("input", { type: "password", placeholder: "••••••••", autocomplete: "off" })),
            err = h("p", { class: "dialog-error", hidden: true })
        ],
        submit: close => {
            const v = owner.value.trim();
            if (v.length < MIN_OWNER_LENGTH) {
                err.textContent = t("error.owner_code_short");
                err.hidden = false;
                owner.focus();
                return;
            }
            close(v);
        }
    }));
}

// What the browser has said about notifications, as one sentence each. The
// browser's answer is not a preference and does not travel: it belongs to this
// browser, for this origin, and no amount of asking will change it.
const NOTIFICATION_STATUS = Object.freeze({
    granted: "settings.notificationsGranted",
    denied: "settings.notificationsDenied",
    default: "settings.notificationsUndecided",
    unsupported: "settings.notificationsUnsupported"
});

// What the browser has said about the camera and the microphone, as one sentence
// each — the same four answers the notifications row above reports, and for the
// same reason: a browser's permission belongs to that browser, for this origin,
// and no amount of asking inside the app will change it.
//
// The one answer here that has no counterpart above is `insecure`. It is not a
// permission at all: the page is being served over http on a host that is not
// localhost, so the browser never offered the camera in the first place and
// there is nothing in its settings to go and change. Saying "blocked" would
// send somebody looking for a switch that does not exist.
const CAPTURE_STATUS = Object.freeze({
    granted: "settings.captureGranted",
    denied: "settings.captureDenied",
    prompt: "settings.captureUndecided",
    unknown: "settings.captureUndecided",
    insecure: "settings.captureInsecure",
    unsupported: "settings.captureUnsupported"
});

/**
 * The camera and microphone, as one row with a button that can still work.
 *
 * Same shape and same reasoning as the notifications row, with the one
 * difference that matters here: `getUserMedia` IS the request. There is no
 * separate permission call for a camera, so the button opens a stream, closes
 * it immediately, and reports what the browser answered. The stream exists only
 * to make the browser ask — nothing is recorded, and nothing is kept.
 *
 * The button is drawn for every state but `granted`, which needs none. The
 * reason is in `permissionState`'s block: "denied" there is a snapshot that
 * outlives a change made in the browser's settings, so a control the app cannot
 * prove is dead is left on screen rather than removed — pressing it either
 * works, or reports a refusal the platform has just confirmed.
 */
function buildCaptureRow() {
    // Nothing to report where the API itself is absent: a browser with no
    // getUserMedia has no permission to grant and no prompt to show, and a row
    // that says so on every device that is not a phone is noise.
    const availability = captureAvailability();
    if (availability === "unsupported") return [];

    const statusEl = h("p", { class: "muted small", id: "capture-status" }, t("common.loading"));
    const extras = [statusEl];

    // The insecure case has no button because it has no button that could work:
    // the prompt is refused before it is ever offered, and the fix is the
    // address the app was opened at.
    if (availability === "insecure") {
        statusEl.textContent = t(CAPTURE_STATUS.insecure);
        return extras;
    }

    // The status is read asynchronously and written back into this row by id —
    // the same shape as the persistence and sync lines lower down the screen,
    // and for the same reason: `navigator.permissions.query` returns a promise.
    permissionState("audio").then(state => {
        statusEl.textContent = t(CAPTURE_STATUS[state] || CAPTURE_STATUS.unknown);
        // Every state except `granted` gets the button, because `granted` has
        // nothing left to ask about and a button for it could not do what it
        // says. The others get one even when the browser says "denied", and that
        // is the deliberate opposite of the rule the notifications row applies, so
        // it is worth saying why: that answer is a load-time snapshot, and Chrome
        // and Edge go on reporting "denied" for an origin until the tab is
        // reloaded — even after the user has allowed the camera in the browser's
        // own settings. Drawing no button in that state told somebody who had
        // already unblocked themselves that there was nothing left to press. An
        // app that cannot know a control has stopped working should not hide it;
        // the press costs one stream and answers authoritatively either way.
        if (state === "granted") return;

        const allowBtn = action({
            label: t("settings.captureAllow"),
            icon: "mic",
            tone: "primary",
            onClick: async () => {
                allowBtn.disabled = true;
                // Asked from a click, which is the one moment a prompt is
                // certain to be welcome rather than merely permitted.
                const answer = await requestCapturePermission("audio");
                statusEl.textContent = t(CAPTURE_STATUS[answer] || CAPTURE_STATUS.unknown);
                // A refusal here is one the platform just confirmed, because
                // `requestCapturePermission` reached `getUserMedia` rather than
                // believing a snapshot — so the button that could change it goes
                // away rather than staying as a promise it cannot keep.
                if (answer !== "prompt" && answer !== "unknown") {
                    document.getElementById("capture-allow")?.remove();
                }
                if (answer === "granted") toast.show("settings.captureAllowed");
                else allowBtn.disabled = false;
            }
        });
        allowBtn.id = "capture-allow";
        extras.push(toolbar(allowBtn));
    }).catch(() => {
        statusEl.textContent = t(CAPTURE_STATUS.unknown);
    });

    return extras;
}

// The device section: everything this app can do that a web page has no right to
// do to somebody unasked.
//
// Three rules, and they are why this is a section rather than a checkbox in the
// corner:
//
//   1. A control that cannot work is not drawn. A device with no Vibration API
//      gets no vibration switch, a browser with no Notification API gets no
//      notification switch, and a browser that has already installed the app gets
//      no install button. The alternative — a greyed-out control that explains
//      nothing — is worse than no control at all.
//
//   2. A preference and a permission are different things, and the screen says
//      which is which. A switch is what the user wants, it is persisted, and it
//      travels with their account to their other devices. The browser's own answer
//      belongs to this browser, is asked for at the one moment it means something
//      (starting a session), and is reported here as a line of text — because
//      that is all it is, and there is nothing on this screen that can change it.
//
//   3. Nothing here is required. A timer with no vibration, no sound, no
//      notifications, no wake lock and no install is a fully working timer. Each
//      is off by a tap, and none of them is a wall of text to get past.
function buildDeviceSection() {
    const settings = store.getState().settings;
    const rows = [];

    // One writer for all four switches. It writes a key and nothing else, so a
    // failed write has to put the switch back where it was — the same rule the
    // language row above follows, and the same reason.
    const save = (key, checked, control) => async () => {
        const before = store.getState().settings;
        try {
            await store.saveSettings({ [key]: checked });
        } catch (e) {
            store.setState({ settings: before });
            if (control) control.checked = !control.checked;
            toast.show(`error.${e?.code || "unexpected"}`);
        }
    };

    // --- vibration -----------------------------------------------------------
    if (haptics.supported()) {
        rows.push(toggleRow({
            id: "set-haptics",
            icon: "bolt",
            label: t("settings.haptics"),
            hint: t("settings.hapticsHint"),
            checked: settings.haptics !== false,
            onChange: (checked, input) => save("haptics", checked, input)()
        }));
    }

    // --- sound ---------------------------------------------------------------
    rows.push(toggleRow({
        id: "set-sound",
        icon: "speaker",
        label: t("settings.sound"),
        hint: t("settings.soundHint"),
        checked: settings.sound !== false,
        onChange: (checked, input) => save("sound", checked, input)()
    }));

    // --- keep the screen awake ----------------------------------------------
    // Offered even where the API is missing, and the hint is where the truth
    // about this device goes: the setting is about the behaviour, and a user who
    // turns it off on a device that cannot do it is not being lied to.
    rows.push(toggleRow({
        id: "set-keep-awake",
        icon: "device",
        label: t("settings.keepAwake"),
        hint: wakeLock.available() ? t("settings.keepAwakeHint") : t("settings.keepAwakeUnsupported"),
        checked: settings.keepAwake !== false,
        onChange: (checked, input) => save("keepAwake", checked, input)()
    }));

    // --- install -------------------------------------------------------------
    // A link, not the install button. The button only exists where the browser has
    // fired beforeinstallprompt — Chromium, and not once the app is installed —
    // so the row underneath is a page that covers all four ways there are, iOS
    // included. A row that led nowhere on two of the three kinds of device would
    // be a worse answer than the hint it replaced.
    rows.push(listRow({
        icon: "download",
        title: t("install.title"),
        subtitle: t("install.lead"),
        href: "/settings/install"
    }));

    // --- quick actions -------------------------------------------------------
    // The same four actions the launcher's long-press menu offers, at an address
    // that exists on every browser. `shortcuts` in the manifest is Chromium-only
    // — iOS and Firefox read the manifest and ignore that key — and this row is
    // how somebody on those two gets the same four things, by bookmarking the
    // page or adding it to the home screen from here.
    rows.push(listRow({
        icon: "bolt",
        title: t("quick.title"),
        subtitle: t("quick.settingsHint"),
        href: "/quick"
    }));

    // --- notifications -------------------------------------------------------
    if (notifications.supported()) {
        const permission = notifications.permission();
        rows.push(toggleRow({
            id: "set-notify",
            icon: "bell",
            label: t("settings.notifications"),
            hint: t("settings.notificationsHint"),
            checked: settings.notify !== false,
            onChange: (checked, input) => save("notify", checked, input)()
        }));

        const statusEl = h("p", { class: "muted small", id: "notification-status" },
            t(NOTIFICATION_STATUS[permission] || NOTIFICATION_STATUS.default));
        const extras = [statusEl];
        // Only an undecided permission can be acted on. A site cannot re-open a
        // prompt the user has already refused, so offering the button in the
        // other two states would be a control that does nothing — which is the
        // thing this whole screen is arranged to avoid.
        if (permission === "default") {
            const allowBtn = action({
                label: t("settings.notificationsAllow"),
                icon: "bell",
                tone: "primary",
                onClick: async () => {
                    // Asked from a click, which is the one moment a prompt is
                    // certain to be welcome rather than merely permitted.
                    const answer = await notifications.ask();
                    const el = settingsPage.own("notification-status");
                    if (el) el.textContent = t(NOTIFICATION_STATUS[answer] || NOTIFICATION_STATUS.default);
                    // The answer is now final, so the button that could change it
                    // goes away rather than staying as a promise it cannot keep.
                    if (answer !== "default") document.getElementById("notification-allow")?.remove();
                    if (answer === "granted") toast.show("settings.notificationsAllowed");
                }
            });
            allowBtn.id = "notification-allow";
            extras.push(toolbar(allowBtn));
        }
        rows.push(...extras);
    }

    // --- camera and microphone ----------------------------------------------
    // The other permission this app asks for, and the one that has no switch:
    // the browser grants it per origin and the app never stores it. It sits
    // here beside notifications because it is exactly the same kind of thing —
    // a browser answer, reported as a line of text, with a button only while
    // the prompt can still be shown.
    if (captureAvailability() !== "unsupported") {
        rows.push(h("p", { class: "setting-label" }, t("settings.capture")));
        rows.push(...buildCaptureRow());
    }

    return pageSection({
        title: t("settings.deviceTitle"),
        icon: "device",
        body: h("div", {}, ...rows)
    });
}

/**
 * Where an attachment's bytes actually are, and how to get them back.
 *
 * This row exists because the answer is genuinely two answers, and only one of
 * them is obvious. The DESCRIPTIONS — "3 photos, 1.2 MB" — sync and go into every
 * backup, so they are wherever the rest of the app is. The BYTES never leave the
 * device that captured them, and they are the part that fills a phone up. A user
 * who cannot see that has no way to answer the only question they would ask,
 * which is "how much of my storage is this".
 *
 * The "delete all" is deliberately coarse and deliberately here: it is the one
 * action that can free space without the user having to find twenty notes, and
 * removing an attachment one at a time is already possible from the note itself.
 * It is behind a confirm because it is the one control on this screen that cannot
 * be undone from where it was pressed.
 */
function buildAttachmentSection() {
    const usageEl = h("p", { class: "muted small", id: "attachment-usage" }, t("common.loading"));
    const clearBtn = action({
        label: t("settings.attachmentsClear"),
        icon: "trash",
        tone: "danger",
        disabled: true,
        onClick: async () => {
            if (!await dialog.confirm("settings.attachmentsClearConfirm")) return;
            clearBtn.disabled = true;
            try {
                const freed = await attachmentService.clearAll();
                usageEl.textContent = t("settings.attachmentsFreed", { size: formatBytes(freed) });
                toast.show("settings.attachmentsCleared");
            } catch (e) {
                toast.show(`error.${e?.code || "unexpected"}`);
            } finally {
                refreshUsage();
            }
        }
    });

    async function refreshUsage() {
        try {
            const bytes = await attachmentService.byteUsage();
            usageEl.textContent = bytes
                ? t("settings.attachmentsUsed", { size: formatBytes(bytes) })
                : t("settings.attachmentsNone");
            clearBtn.disabled = !bytes;
        } catch (e) {
            // A usage figure that cannot be read is reported as unknown rather
            // than as zero: "nothing stored" is a claim, and a store that failed
            // to open is not the same thing.
            usageEl.textContent = t("settings.attachmentsUnknown");
        }
    }

    const section = pageSection({
        title: t("settings.attachmentsTitle"),
        icon: "image",
        body: h("div", {},
            h("p", { class: "muted small" }, t("settings.attachmentsHint")),
            usageEl,
            toolbar(clearBtn)
        )
    });

    // Read on the way out, the way the two existing async rows do: a figure read
    // by a mount that has since been replaced must not land in the next one.
    refreshUsage();
    return section;
}

export const settingsPage = {
    title: () => t("nav.settings"),
    mount(root) {
        // The language picker is the app's select control, in a setting row like
        // every other setting. Settings used to be the only screen in the app
        // built from bare labels, controls and two stray hairlines, so it read as
        // a form someone typed rather than a page in this design.
        const { select, element } = selectControl({
            options: [{ value: "en", label: "English" }, { value: "ar", label: "العربية" }],
            value: getLanguage(),
            ariaLabel: t("settings.language")
        });
        // Persisted, so the choice survives a reload. It used to be applied to the
        // in-memory language only and never written anywhere, so choosing Arabic
        // worked until the next refresh and then quietly reverted to the
        // browser's locale — the setting looked broken rather than unsaved.
        select.addEventListener("change", async () => {
            const chosen = select.value;
            try {
                await store.saveSettings({ language: chosen });
            } catch (e) {
                // A failed write must not leave the UI claiming a preference that
                // will not be there next time.
                select.value = getLanguage();
                toast.show(`error.${e?.code || "unexpected"}`);
                return;
            }
            setLanguage(chosen);
            router.refresh();
        });

        const exportBtn = action({
            label: t("settings.export"),
            icon: "download",
            onClick: async () => {
                try {
                    const isNew = !(await cryptoService.hasEncryptionKeys());
                    const password = isNew ? await promptCreatePassword() : await promptExistingPassword();
                    if (password == null) return; // cancelled
                    const hasOwner = !!(await authService.getOwnerVerifier());
                    const ownerCode = await promptOwnerCode({ isNew: !hasOwner });
                    if (ownerCode == null) return; // cancelled
                    const res = await backupService.exportAll({ password, ownerCode });
                    if (!res.ok) { toast.show(`error.${res.code || "unexpected"}`); return; }
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(res.blob);
                    a.download = res.filename;
                    a.click();
                    URL.revokeObjectURL(a.href);
                } catch (e) { if (e?.code !== "cancelled") toast.show(`error.${e?.code || "unexpected"}`); }
            }
        });

        const input = h("input", { type: "file", accept: "application/json", class: "sr-only" });
        input.addEventListener("change", async () => {
            const f = input.files?.[0];
            if (!f) return;
            try {
                const hasKey = await cryptoService.hasEncryptionKeys();
                const password = hasKey ? await promptExistingPassword(null, "import") : await promptCreatePassword({ hintKey: "settings.importPasswordHint" });
                if (password == null) return; // cancelled
                const parsed = await backupService.parse(await f.text(), password, {
                    getOwnerCode: async () => {
                        const hasOwner = !!(await authService.getOwnerVerifier());
                        return promptOwnerCode({ isNew: !hasOwner });
                    }
                });
                if (await dialog.confirm("settings.importConfirm")) {
                    await backupService.importAll(parsed.data);
                    await store.refresh("all");
                    router.navigate("/");
                }
            } catch (e) { if (e?.code !== "cancelled") toast.show(`error.${e?.code || "unexpected"}`); }
        });

        const importBtn = action({ label: t("settings.import"), icon: "upload", onClick: () => input.click() });
        const clear = action({
            label: t("settings.clearAll"),
            icon: "trash",
            tone: "danger",
            onClick: async () => {
                if (await dialog.confirm("settings.clearConfirm")) {
                    try { await backupService.clearAll(); await store.refresh("all"); router.navigate("/"); }
                    catch (e) { toast.show(`error.${e?.code || "unexpected"}`); }
                }
            }
        });

        const syncStatusEl = h("p", { class: "muted", id: "sync-status" }, t("common.loading"));
        const syncInputs = this.buildSyncSection();

        root.append(page(
            pageHead({ title: t("nav.settings"), icon: "sliders" }),

            // A card, not a titled section: the page heading already says
            // "Settings", and a second heading with the same words under it was
            // one of the two stray hairlines that used to be doing the work of
            // structure on this screen.
            card(
                settingRow({ icon: "globe", label: t("settings.language"), control: element }),
                h("p", { class: "muted small" }, t("settings.iosHint")),
                // The install button, and only where the browser has actually
                // offered one — and only until the row below takes over. Keeping
                // both would put two controls for one act on one screen, and the
                // second one is the one that works on iOS.
                canInstall() ? toolbar(action({
                    label: t("settings.install"),
                    icon: "download",
                    tone: "primary",
                    onClick: async () => {
                        const accepted = await promptInstall();
                        if (!accepted) toast.show("settings.installDismissed");
                    }
                })) : null,
                toolbar(exportBtn, importBtn, clear),
                input
            ),

            buildDeviceSection(),

            pageSection({
                title: t("settings.syncTitle"),
                icon: "cloud",
                body: h("div", {}, ...syncInputs, syncStatusEl)
            }),

            buildAttachmentSection(),

            pageSection({
                title: t("settings.persistence"),
                icon: "database",
                body: h("div", {},
                    h("p", { class: "muted", id: "persistence-status" }, t("common.loading")),
                    h("p", { class: "muted small" }, `${t("settings.version")} ${APP_VERSION}`)
                )
            })
        ));

        // Both of these read asynchronously and write into the page by id, so they
        // are dropped on the way out: a check started by one mount must not land
        // in the DOM of the next one and leave a stale reconnect button behind.
        this.alive = true;
        this.refreshSyncStatus().catch(e => console.warn("sync status", e));
        this.checkPersistence().catch(e => console.warn("persistence", e));
    },

    unmount() {
        this.alive = false;
    },

    // Resolves the element only while this page is still the one on screen. The
    // settings page is not the only thing that uses #sync-status, and a global
    // lookup alone would happily hand a torn-down page the new page's node.
    own(id) {
        if (this.alive === false) return null;
        const el = document.getElementById(id);
        return el ? el : null;
    },
    buildSyncSection() {
        const syncFileInput = h("input", { type: "file", accept: ".enc,.sync.enc,application/octet-stream,.json,application/json", class: "sr-only" });

        const importSyncFileText = async text => {
            let password = null;
            let ownerCode = null;
            for (;;) {
                const res = await syncService.importSyncFile(text, {
                    getPassword: async code => {
                        if (password !== null) return password;
                        const hasKey = await cryptoService.hasEncryptionKeys();
                        password = hasKey
                            ? await promptExistingPassword(code, "import")
                            : await promptCreatePassword({ code, hintKey: "settings.importPasswordHint" });
                        return password;
                    },
                    getOwnerCode: async code => {
                        if (ownerCode !== null) return ownerCode;
                        const hasOwner = !!(await authService.getOwnerVerifier());
                        ownerCode = await promptOwnerCode({ code, isNew: !hasOwner });
                        return ownerCode;
                    }
                });

                // This device is already set up for a DIFFERENT space than the
                // file. Importing silently did nothing before — now we explain
                // and offer to replace this device's sync setup with the file.
                if (res.ok && res.requiresAction === "cross_space") {
                    const proceed = await dialog.confirm("settings.syncCrossSpaceConfirm");
                    if (!proceed) return;
                    await syncService.clearConfig();
                    await cryptoService.clearEncryptionKeys();
                    continue; // retry with the same file password/owner code
                    // (the device is fresh now; openSpace binds the file's key)
                }
                if (!res.ok) {
                    const silent = res.code === "cancelled" || (res.code === "password_required" && password === null);
                    if (!silent) toast.show(`error.${res.code || "unexpected"}`);
                    return;
                }
                settingsPage.refreshSyncStatus().catch(() => {});
                toast.show("settings.syncFileImported");
                return;
            }
        };

        syncFileInput.addEventListener("change", async () => {
            const f = syncFileInput.files?.[0];
            if (!f) return;
            try { await importSyncFileText(await f.text()); }
            catch (e) { if (e?.code !== "cancelled") toast.show(`error.${e?.code || "unexpected"}`); }
        });

        const importFileBtn = action({
            label: t("settings.syncFileImport"),
            icon: "upload",
            tone: "primary",
            onClick: () => syncFileInput.click()
        });
        const exportFileBtn = action({
            label: t("settings.syncFileExport"),
            icon: "download",
            onClick: async () => {
                try {
                    const res = await syncService.exportSyncFile();
                    if (!res.ok) { toast.show(`error.${res.code || "unexpected"}`); return; }
                    const password = res.isNew ? await promptCreatePassword() : await promptExistingPassword();
                    if (password == null) return; // cancelled
                    const ownerCode = await promptOwnerCode({ isNew: !res.hasOwner });
                    if (ownerCode == null) return; // cancelled
                    const finalRes = await syncService.exportSyncFile({ password, ownerCode });
                    if (!finalRes.ok) { toast.show(`error.${finalRes.code || "unexpected"}`); return; }
                    const blob = new Blob([finalRes.json], { type: "application/octet-stream" });
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(blob);
                    a.download = finalRes.fileName;
                    a.click();
                    URL.revokeObjectURL(a.href);
                    // The first export is what CREATES the space, so the status
                    // line under this very section went on reading "sync is not
                    // configured" until the user navigated away and back. The
                    // import path already refreshed; this one did not.
                    settingsPage.refreshSyncStatus().catch(() => {});
                    toast.show("settings.syncFileExported");
                } catch (e) { if (e?.code !== "cancelled") toast.show(`error.${e?.code || "unexpected"}`); }
            }
        });

        // The refresh, on its own row above the file buttons and in the primary
        // tone, because it is a different KIND of act from the two below it: this
        // one asks the server a question, those two move a file between devices.
        // It also gets the primary tone on merit — it is the button a person comes
        // here to press, and the whole reason to look at this section.
        //
        // Sync is automatic, which is the point of it, and automatic is invisible:
        // there is no way to tell from the rest of the app whether the change you
        // just made is on the other device yet, so the one place that can answer
        // it is a button that says so. What it runs is the ordinary full run —
        // everything queued goes up, then everything the server holds comes down —
        // so the numbers it reports are the numbers the loop would have produced
        // a few seconds later anyway, and nothing here is a second idea of what
        // syncing means.
        let refreshing = false;
        const syncNowBtn = action({
            label: t("settings.syncNow"),
            icon: "refresh",
            tone: "primary",
            // A tooltip rather than another paragraph under the row: what the
            // button does in full is a sentence, and a sentence under every
            // control is how a settings screen turns into a manual. The
            // accessible name stays the label either way.
            title: t("settings.syncNowHint"),
            onClick: async () => {
                // The service refuses a second run while one is in flight and
                // answers "busy", which is right for a scheduled call and wrong
                // for a person who just pressed the button: the guard is here so
                // the answer is "it is already running" rather than an error.
                if (refreshing) return;
                refreshing = true;
                syncNowBtn.disabled = true;
                syncNowBtn.setAttribute("aria-busy", "true");
                try {
                    const res = await syncService.syncNow();
                    if (res.ok) toast.show("settings.syncDone", { sent: res.sent, pulled: res.pulled });
                    else toast.show(`error.${res.code || "unexpected"}`, { invalid: res.invalid ?? 0 });
                } catch (e) {
                    toast.show(`error.${e?.code || "unexpected"}`, { invalid: 0 });
                } finally {
                    refreshing = false;
                    syncNowBtn.disabled = false;
                    syncNowBtn.removeAttribute("aria-busy");
                    // Either way, not only on success: a run that failed still
                    // moved the status line (to "offline", to an error, to
                    // "needs the secret file"), and the reconnect button that
                    // goes with the last of those is drawn from here.
                    settingsPage.refreshSyncStatus().catch(() => {});
                }
            }
        });

        return [
            h("p", { class: "muted" }, t("settings.syncHint")),
            toolbar(syncNowBtn),
            h("p", { class: "muted" }, t("settings.syncFileHint")),
            toolbar(exportFileBtn, importFileBtn),
            syncFileInput
        ];
    },
    async refreshSyncStatus() {
        const el = this.own("sync-status");
        if (!el) return;
        const oldBtn = document.getElementById("sync-reconnect");
        if (oldBtn) oldBtn.remove();
        // Read before writing: both of these touch the network, and the page can
        // be navigated away from while they are in flight. Re-checked after each
        // await so a result that arrives late is dropped rather than painted into
        // whatever is on screen by then.
        let st, pending;
        try {
            st = await syncService.status();
            pending = await syncService.pendingCount();
        } catch (e) {
            if (this.own("sync-status") === el) el.textContent = t("settings.syncError", { code: e?.code ?? "—" });
            return;
        }
        if (this.own("sync-status") !== el) return;

        let msg, needReconnect = false;
        switch (st.status) {
            case "idle":
                msg = t("settings.syncIdle", { at: st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString() : "—", pending });
                break;
            case "syncing":
                msg = t("settings.syncSyncing", { pending });
                break;
            case "offline":
                msg = t("settings.syncOffline", { pending });
                break;
            case "unauthorized":
                msg = t("settings.syncUnauthorized");
                needReconnect = true;
                break;
            case "error":
                msg = t("settings.syncError", { code: st.lastError || "—" });
                break;
            default:
                msg = t("settings.syncNotConfigured", { pending });
        }
        el.textContent = msg;

        // When the server session expired (401s on every push/pull), offer a
        // one-tap reconnect: re-open the space with the password, which issues a
        // fresh session cookie without re-importing the secret file.
        if (needReconnect || st.authRequired) {
            const btn = action({
                label: t("settings.syncReconnect"),
                icon: "refresh",
                onClick: async () => {
                    try {
                        const cfg = await syncService.getConfig();
                        const code = cfg?.code;
                        if (!code) return;
                        const password = await promptExistingPassword(code, "import");
                        if (password == null) return; // cancelled
                        const res = await syncService.openSpace({ code, password });
                        if (!res.ok) { toast.show(`error.${res.code || "unexpected"}`); return; }
                        settingsPage.refreshSyncStatus().catch(() => {});
                        toast.show("settings.syncReconnected");
                    } catch (e) { if (e?.code !== "cancelled") toast.show(`error.${e?.code || "unexpected"}`); }
                }
            });
            btn.id = "sync-reconnect";
            el.insertAdjacentElement("afterend", btn);
        }
    },
    async checkPersistence() {
        const el = this.own("persistence-status");
        if (!el) return; // settings page not mounted (or unmounted while awaiting)

        // Re-entrant: drop any button left from a previous check.
        const oldBtn = document.getElementById("persistence-btn");
        if (oldBtn) oldBtn.remove();

        const show = text => { if (this.own("persistence-status") === el) el.textContent = text; };

        if (navigator.storage && navigator.storage.persist) {
            try {
                const persisted = await navigator.storage.persisted();
                if (this.own("persistence-status") !== el) return; // page unmounted meanwhile
                if (!persisted) {
                    show(t("settings.notPersisted"));
                    const btn = action({
                        label: t("settings.requestPersistence"),
                        icon: "lock",
                        onClick: async () => {
                            try { await navigator.storage.persist(); }
                            catch { /* permission/availability issue — silent */ }
                            await this.checkPersistence();
                        }
                    });
                    btn.id = "persistence-btn";
                    // Keep the status <p> in the DOM so a later re-check can
                    // find it; the button sits right after it.
                    el.insertAdjacentElement("afterend", btn);
                } else {
                    show(t("settings.persisted"));
                }
            } catch (e) { show(t("settings.unknown")); }
        } else {
            show(t("settings.unsupported"));
        }
    }
};
