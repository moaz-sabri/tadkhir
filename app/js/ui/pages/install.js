import { h } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import { canInstall, promptInstall } from "../../app/sw-register.js";
import { isInstalled, detectedPlatform } from "../../app/platform.js";
import { page, pageHead, pageSection, card, action, toolbar, listRow, backTo } from "../components/ui.js";
import { toast } from "../components/toast.js";

// How to install this app, on whatever device is reading the page.
//
// WHY THIS IS A PAGE AND NOT A HINT. The install capability is not one thing, it
// is four, and the app can only reach one of them. Chromium fires
// beforeinstallprompt, which the app can hold and turn into a real button (see
// sw-register.js). iOS has no such event at all — the only route is the Share
// menu, by hand, in Safari. Desktop Firefox does not install web apps. Safari on
// a Mac installs from the File menu.
//
// So a single sentence cannot be right for everybody, and a button that only
// sometimes works is worse than no button. The page names all four, says which
// one is this device, and draws the button ONLY where the browser has actually
// offered one — the same rule the Settings row already follows, applied to a
// screen whose whole subject is the rule.
//
// It lives under Settings rather than in the navigation on purpose. The bottom
// bar is already eight items wide on a 360px phone, and a ninth is a clipped
// label; and installing is something a person does once, not somewhere they live.

// The benefits, as rows: a glyph, a name, and a line saying what it is. The same
// shape as a setting row, so the page is made of the parts the rest of the app is
// made of.
const BENEFITS = [
    ["cloud", "benefitOffline"],
    ["database", "benefitStorage"],
    ["bolt", "benefitLaunch"],
    ["refresh", "benefitUpdates"]
];

// The platform blocks, in the order they are most likely to be the reader's. The
// detected one is moved to the front at mount time rather than being the only one
// shown: a person on iOS needs the iOS steps, but somebody reading over a
// colleague's shoulder may need another two, and hiding them would make the page
// useless the moment it is opened on the wrong device.
//
// `note` is a key that exists for only one of them, because only one of them has
// something the reader cannot work out from the steps — iOS, where there is no
// button anywhere and no way for a page to add one. Naming it here rather than
// probing for it keeps the "which strings exist" question in one place.
const PLATFORMS = [
    { id: "ios", icon: "device", note: "iosNote" },
    { id: "android", icon: "device", note: null },
    { id: "desktop", icon: "globe", note: null },
    { id: "firefox", icon: "warning", note: null }
];

function stepBlock({ id, icon, note, isYours }) {
    return card(
        h("div", { class: "row-line" },
            h("span", { class: "row-title" }, t(`install.${id}`)),
            // The marker is a tag beside the name rather than a line above it, so
            // the reader's own platform is found by scanning four titles instead
            // of by reading all four.
            isYours ? h("span", { class: "badge" }, t("install.yours")) : null
        ),
        // A paragraph, not a list: each of these is one or two menu taps written
        // as a sentence, and a one-item ordered list reads as a broken list.
        h("p", { class: "muted" }, t(`install.${id}Steps`)),
        note ? h("p", { class: "dialog-warning" }, t(`install.${note}`)) : null
    );
}

export const installPage = {
    title: () => t("install.title"),

    mount(root) {
        const yours = detectedPlatform();
        const ordered = [
            ...PLATFORMS.filter(p => p.id === yours),
            ...PLATFORMS.filter(p => p.id !== yours)
        ];
        const installed = isInstalled();

        // The one control this page can own, and only where the browser has
        // actually offered one. Everywhere else the platform block below is the
        // whole answer, and a disabled or dead button beside it would be a lie
        // about what the device can do.
        const installControl = installed
            ? card(listRow({
                icon: "check",
                title: t("install.installed"),
                subtitle: t("install.installedHint")
            }))
            : canInstall()
                ? card(
                    h("p", { class: "muted" }, t("install.yours")),
                    toolbar(action({
                        label: t("install.installNow"),
                        icon: "download",
                        tone: "primary",
                        onClick: async () => {
                            const accepted = await promptInstall();
                            if (!accepted) toast.show("install.installDismissed");
                        }
                    }))
                )
                : null;

        root.append(page(
            // The back control is the page head's leading element, where every
            // other detail screen in the app puts it. As a grid item of its own
            // it stretched to the full column width, which made a link out of a
            // screen look like the primary action of one.
            pageHead({
                title: t("install.title"),
                icon: "download",
                leading: backTo("/settings")
            }),
            h("p", { class: "muted" }, t("install.lead")),
            installControl,

            pageSection({
                title: t("install.benefitsTitle"),
                icon: "check",
                body: h("div", { class: "list" },
                    ...BENEFITS.map(([icon, key]) => listRow({ icon, title: t(`install.${key}`) }))
                )
            }),

            pageSection({
                title: t("install.stepsTitle"),
                icon: "info",
                body: h("div", { class: "install-steps" },
                    ...ordered.map(p => stepBlock({ ...p, isYours: p.id === yours }))
                )
            })
        ));
    }
};
