// Which device is reading the page, and is the app already installed.
//
// The install page needs to answer two questions, and neither is guessable from
// the app's own state: whether the app is running as an installed app, and which
// set of install steps belongs to the device in the reader's hand.
//
// Both are guesses, and they are guesses on purpose — every heuristic here has a
// documented failure, and each one is used only to ORDER a page that already
// contains every answer. Getting `ios` wrong does not hide the iOS steps from
// anybody; it puts them second. That is the property that makes a heuristic safe
// to ship on a page whose content is the fallback.

// Installed, in the two senses browsers actually use.
//
//   display-mode: standalone  — Chromium, when launched from a home-screen or
//                                 desktop icon.
//   navigator.standalone      — iOS Safari, the only signal it exposes.
//
// Neither is set in a normal browser tab, which is the point: a user who has not
// installed is told how to, and a user who has is told it is done. Safari on macOS
// in a standalone window reports through display-mode like everything else.
export function isInstalled() {
    if (typeof window === "undefined") return false;
    const mode = window.matchMedia?.("(display-mode: standalone)")?.matches;
    return Boolean(mode || window.navigator?.standalone);
}

// The platform whose steps are most likely the reader's.
//
// iOS is checked BEFORE the desktop branch on purpose, and the iPad case is the
// reason: an iPad reports a Mac platform by default ("MacIntel"), and if the Mac
// branch were first, every iPad would be told to use Chrome on a computer. The
// only signal that separates them is the touch point count, so it is checked
// second and no other check is allowed to win over it.
//
// A desktop browser on a touchscreen Windows laptop is the mirror of that, and
// there is no way to tell the two apart — so it is reported as `desktop`, which
// is the answer that is also correct for it.
export function detectedPlatform() {
    if (typeof navigator === "undefined") return "desktop";
    const ua = navigator.userAgent || "";

    // iPhone, iPod, and iPad. iPadOS 13+ claims to be a Mac; `maxTouchPoints > 1`
    // is what gives it away, and it is checked before the Mac test below.
    const iPadOSAsMac = /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
    if (/iPhone|iPod|iPad/.test(ua) || iPadOSAsMac) return "ios";

    if (/Android/.test(ua)) return "android";

    if (/Firefox\//.test(ua)) return "firefox";
    if (/Windows|Macintosh|Linux|CrOS/.test(ua)) return "desktop";

    // An unrecognised browser on a phone is far more likely to be a phone than a
    // desktop, and the Android block is above, so this is the desktop-shaped
    // remainder.
    return "desktop";
}
