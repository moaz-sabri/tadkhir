// The icon registry ظ¤ the single place in the app where a shape is drawn.
//
// Every glyph lives in `ICONS` below, keyed by what it *means* rather than by
// where it is used, and `uiIcon(name)` is the only way one reaches the screen.
// Nothing else in the codebase holds SVG path data. That is the whole point: a
// concept is drawn once, so the same arrow cannot be redrawn slightly differently
// in two places, and a new screen picks an existing name instead of inventing a
// shape. (It was the duplication, not the artwork: the income arrow existed
// twice, and the clock and the bookmark existed three and two times.)
//
// The house style, decided once in `icon()` and never overridden per icon:
//   * 24├ù24 viewBox, stroked paths only, `fill="none"`, `currentColor` ظ¤ so an
//     icon is white on the black ground, black on a filled white button, and
//     grey when it is dimmed, with no per-icon colour anywhere. Mixing a filled
//     set with a stroked one puts a single mismatched icon on a row.
//   * 1.75 stroke with round caps and joins, so a 19px icon in the nav bar and a
//     24px one on a share target carry the same weight.
//   * `aria-hidden` ظ¤ every icon sits inside a control that has its own text or
//     an aria-label, so announcing the icon too would read the same thing twice.
//     A control whose *only* content is an icon gets an aria-label instead.
//
// Geometry conventions, so the set looks like one hand drew it:
//   * 3px of inset on every side (nothing touches the 24├ù24 box edge).
//   * Straight lines and shallow curves; a curve that can be a straight line is.
//   * Two to four paths per icon, in reading order.

const SVG_NS = "http://www.w3.org/2000/svg";

export function icon(paths, { className = "icon", size = null } = {}) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    // Slightly under 2 so the set stays even at the 19-21px the navigation bar
    // renders it at; a full 2 looks heavier than the text beside it.
    svg.setAttribute("stroke-width", "1.75");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    if (className) svg.setAttribute("class", className);
    if (size) {
        svg.setAttribute("width", size);
        svg.setAttribute("height", size);
    }
    for (const d of [paths].flat()) {
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("d", d);
        svg.append(path);
    }
    return svg;
}

// ---------------------------------------------------------------- the set ---

export const ICONS = {
    // ---- The destinations --------------------------------------------------
    home: [
        "M3.5 10.5 12 3.5l8.5 7",
        "M6 9.5V19a1.5 1.5 0 0 0 1.5 1.5h2V15h5v5.5h2A1.5 1.5 0 0 0 18 19V9.5"
    ],
    kanban: [
        "M4 5.5h16",
        "M4 9.5h16",
        "M4 13.5h16",
        "M4 17.5h16",
        "M8 5.5v12",
        "M12 5.5v12",
        "M16 5.5v12"
    ],
    tasks: [
        "M9 6.5h11",
        "M9 12h11",
        "M9 17.5h11",
        "M3 5.5 4.5 7 7 4.5",
        "M3 11l1.5 1.5L7 10",
        "M3 16.5 4.5 18 7 15.5"
    ],
    clock: [
        "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z",
        "M12 7.5V12l3 2"
    ],
    bookmark: [
        "M6.5 4h11a1 1 0 0 1 1 1v15l-6.5-4-6.5 4V5a1 1 0 0 1 1-1Z"
    ],
    wallet: [
        "M3 8a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v1",
        "M3 8v9.5A1.5 1.5 0 0 0 4.5 19h15a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 19.5 10H4.5A1.5 1.5 0 0 1 3 8.5",
        "M16.5 13.5h1.5"
    ],
    chart: [
        "M4 20h16",
        "M7.5 20v-6.5",
        "M12 20V6.5",
        "M16.5 20v-9.5"
    ],
    sliders: [
        "M4 7h5",
        "M13 7h7",
        "M4 12h9",
        "M17 12h3",
        "M4 17h11",
        "M19 17h1",
        "M11 5v4",
        "M15 10v4",
        "M17 15v4"
    ],

    // ---- Motion and state --------------------------------------------------
    play: ["M8 5.5v13l11-6.5Z"],
    pause: ["M9.5 5v14", "M14.5 5v14"],
    stop: ["M6.5 6.5h11v11h-11z"],
    check: ["m5 13 4.5 4.5L19 7"],
    checked: ["m4 12.5 4 4 6-6.5", "m11.5 16.5 1 1 6.5-6.5"],
    close: ["m6 6 12 12", "m18 6-12 12"],
    plus: ["M12 5v14", "M5 12h14"],
    minus: ["M5 12h14"],
    refresh: [
        "M20 12a8 8 0 1 1-2.6-5.9",
        "M20.5 4v4.5H16"
    ],
    history: [
        "M4 12a8 8 0 1 0 2.6-5.9",
        "M3.5 4v4.5H8",
        "M12 8v4.4l3 1.8"
    ],
    skip: ["M6 6.5 14 12l-8 5.5v-11Z", "M18 6v12"],

    // ---- Direction. `back` and the rest of this group are flipped in RTL ----
    //    by the `icon-flip` class, so "back" points the way the reader came.
    back: ["M19.5 12h-15", "m10.5 6-6 6 6 6"],
    forward: ["M4.5 12h15", "m13.5 6 6 6-6 6"],
    chevronRight: ["m9.5 5.5 6.5 6.5-6.5 6.5"],
    chevronDown: ["m5.5 9.5 6.5 6.5 6.5-6.5"],
    external: [
        "M14 4h6v6",
        "m20 4-8.5 8.5",
        "M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"
    ],
    undo: ["m9 5.5-4.5 4.5L9 14.5", "M4.5 10H14a5.5 5.5 0 0 1 0 11h-3.5"],
    arrowUp: ["M12 19.5v-15", "m6.5 11 5.5-5.5 5.5 5.5"],
    arrowDown: ["M12 4.5v15", "m6.5 13 5.5 5.5 5.5-5.5"],

    // ---- Editing and removal ----------------------------------------------
    pencil: [
        "M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3Z",
        "m14.5 6.5 3 3"
    ],
    trash: [
        "M4 7h16",
        "M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7",
        "M6.5 7 7.4 19a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7",
        "M10 11v5.5",
        "M14 11v5.5"
    ],
    copy: [
        "M9 9h9.5A1.5 1.5 0 0 1 20 10.5V20a1.5 1.5 0 0 1-1.5 1.5H9A1.5 1.5 0 0 1 7.5 20v-9.5A1.5 1.5 0 0 1 9 9Z",
        "M16.5 6.5V5A1.5 1.5 0 0 0 15 3.5H5A1.5 1.5 0 0 0 3.5 5v10A1.5 1.5 0 0 0 5 16.5h1.5"
    ],

    // ---- Formatting ---------------------------------------------------------
    // The rich-text bar (ui/components/markdown-editor.js). Drawn as the marks
    // themselves rather than as letters, so they read at 16px next to Arabic and
    // Latin alike, and so a note showing a code span looks like the button that
    // made it.
    bold: [
        "M7 4.5h6.2a3.7 3.7 0 0 1 0 7.4H7Z",
        "M7 11.9h7a3.8 3.8 0 0 1 0 7.6H7Z"
    ],
    italic: ["M15.5 4.5h-5", "M8.5 19.5h-5", "M14.5 4.5 9.5 19.5"],
    code: ["m8.5 8-4 4 4 4", "m15.5 8 4 4-4 4", "m13.5 5-3 14"],
    // Bullets, not the checkmarks of `tasks`: a list of lines in a note is a
    // different thing from a list of things to tick off, and the two are on
    // screen at once on a page.
    list: [
        "M9.5 6.5H20",
        "M9.5 12H20",
        "M9.5 17.5H20",
        "M4.6 6.5h.01",
        "M4.6 12h.01",
        "M4.6 17.5h.01"
    ],

    // ---- Finding and filtering ---------------------------------------------
    search: [
        "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z",
        "m16.2 16.2 4 4"
    ],
    filter: ["M3.5 5.5h17l-6.5 7.5v6l-4 2v-8L3.5 5.5Z"],
    sort: ["M4 7h16", "M6.5 12h11", "M9.5 17h6"],

    // The bar's own overflow: three lines, no bullets. It is deliberately NOT
    // `list`, which is a checklist and reads as items to tick off — the wrong
    // promise for a door into the rest of the app.
    menu: ["M4 7h16", "M4 12h16", "M4 17h16"],

    // ---- Files, devices, data ----------------------------------------------
    download: [
        "M12 4v10",
        "m8 11 4 4 4-4",
        "M4.5 17.5v1A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-1"
    ],
    upload: [
        "M12 20V10",
        "m8 13 4-4 4 4",
        "M4.5 6.5v-1A1.5 1.5 0 0 1 6 4h12a1.5 1.5 0 0 1 1.5 1.5v1"
    ],
    file: [
        "M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8Z",
        "M14 3.5V8h4.5"
    ],
    // The three kinds an attachment can be. They are drawn as the THING rather
    // than as a generic "attachment" clip, because a strip of thumbnails is
    // exactly the place where a user needs to tell a photograph from a voice
    // memo at a glance and a paperclip tells them nothing.
    image: [
        "M5.5 4.5h13A1.5 1.5 0 0 1 20 6v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18V6a1.5 1.5 0 0 1 1.5-1.5Z",
        "m4 16 4.5-4.5 3.5 3.5 3-3L20 16",
        "M15.25 9.25h.01"
    ],
    mic: [
        "M12 4.5a2.25 2.25 0 0 1 2.25 2.25v4.5a2.25 2.25 0 0 1-4.5 0v-4.5A2.25 2.25 0 0 1 12 4.5Z",
        "M6.75 11.25a5.25 5.25 0 0 0 10.5 0",
        "M12 16.5v3",
        "M9.5 19.5h5"
    ],
    video: [
        "M3.5 9.5A1.5 1.5 0 0 1 5 8h8a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 13 16H5a1.5 1.5 0 0 1-1.5-1.5Z",
        "m14.5 11 5-2.75v7.5L14.5 13Z"
    ],
    folder: ["M3.5 7.5h6l2 2.5h9v8a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18Z"],
    link: [
        "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
        "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
    ],
    database: [
        "M12 8c4.4 0 8-1.1 8-2.5S16.4 3 12 3 4 4.1 4 5.5 7.6 8 12 8Z",
        "M20 5.5v13c0 1.4-3.6 2.5-8 2.5s-8-1.1-8-2.5v-13",
        "M20 12c0 1.4-3.6 2.5-8 2.5S4 13.4 4 12"
    ],
    cloud: [
        "M7 18.5a4 4 0 0 1-.4-8 5.5 5.5 0 0 1 10.4-.9 3.9 3.9 0 0 1 .5 7.8"
    ],
    device: [
        "M8 3.5h8A1.5 1.5 0 0 1 17.5 5v14a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 19V5A1.5 1.5 0 0 1 8 3.5Z",
        "M10.5 17.5h3"
    ],
    lock: [
        "M7 10.5V8a5 5 0 0 1 10 0v2.5",
        "M6 10.5h12A1.5 1.5 0 0 1 19.5 12v6.5a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18.5V12A1.5 1.5 0 0 1 6 10.5Z"
    ],
    globe: [
        "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z",
        "M3.5 9.5h17",
        "M3.5 14.5h17",
        "M12 3a14 14 0 0 1 0 18",
        "M12 3a14 14 0 0 0 0 18"
    ],

    // ---- Subjects ----------------------------------------------------------
    calendar: [
        "M6 5.5h12A1.5 1.5 0 0 1 19.5 7v11a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V7A1.5 1.5 0 0 1 6 5.5Z",
        "M4.5 10h15",
        "M8 3.5v4",
        "M16 3.5v4"
    ],
    person: [
        "M12 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z",
        "M5 20a7 7 0 0 1 14 0"
    ],
    tag: [
        "M11 3.5H5.5A2 2 0 0 0 3.5 5.5V11L13 20.5 20.5 13 11 3.5Z",
        "M8 8h.01"
    ],
    note: [
        "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z",
        "M14 2v6h6",
        "M16 13H8",
        "M16 17H8"
    ],
    repeat: [
        "M4 9.5A5 5 0 0 1 9 4.5h9",
        "m15 2 3 2.5-3 2.5",
        "M20 14.5A5 5 0 0 1 15 19.5H6",
        "m9 22-3-2.5 3-2.5"
    ],
    bell: [
        "M18 15.5V11a6 6 0 1 0-12 0v4.5L4.5 18h15L18 15.5Z",
        "M10 21h4"
    ],
    // The alert tone. Drawn as a cone and two waves, stroked like the rest of the
    // set, and it exists because the settings screen now has a switch for the
    // sound and a switch with no glyph beside it is a switch with no meaning.
    speaker: [
        "M4 9.5h3.5L12 6v12L7.5 14.5H4Z",
        "M15 10a3 3 0 0 1 0 4",
        "M17.5 9a4 4 0 0 1 0 6"
    ],
    pin: [
        "M9 3.5h6l-.8 5.2 3.3 3.3H6.5l3.3-3.3L9 3.5Z",
        "M12 12v8.5"
    ],
    archive: [
        "M3.5 7.5h17v3h-17z",
        "M5 10.5v8A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-8",
        "M9.5 14.5h5"
    ],
    scale: [
        "M12 4.5v15",
        "M6 8.5h12",
        "m6 8.5-3 6.5h6L6 8.5Z",
        "m18 8.5-3 6.5h6L18 8.5Z"
    ],
    target: [
        "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z",
        "M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z",
        "M12 13.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Z"
    ],
    percent: [
        "M19 5 5 19",
        "M7.5 9.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
        "M16.5 18.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"
    ],

    // ---- Money. An arrow over a baseline; the hand says whose side it is ---.
    moneyIn: ["M12 20V5", "m6 11 6-6 6 6", "M4 4h16"],
    moneyOut: ["M12 4v15", "m6 13 6 6 6-6", "M4 20h16"],
    // A debt is not a completed flow, so it gets the hand: it sits on the side
    // the money travels FROM. Owed to me ظ¤ hand below, the amount rising out of
    // it. Owed by me ظ¤ hand above, the amount falling away from it. The same
    // up/down reading as income/expense, with the cup saying whose side this is.
    owedToMe: ["M12 15V7", "m8 11 4-4 4 4", "M3 16c0 2 2 3 4.5 3h9c2.5 0 4.5-1 4.5-3"],
    owedByMe: ["M12 9v8", "m8 13 4 4 4-4", "M3 8c0-2 2-3 4.5-3h9c2.5 0 4.5 1 4.5 3"],

    // ---- Messages and states ----------------------------------------------
    inbox: [
        "M4 13.5h4l1.5 3h5l1.5-3h4",
        "M5.6 5.2 4 13.5v4A1.5 1.5 0 0 0 5.5 19h13a1.5 1.5 0 0 0 1.5-1.5v-4l-1.6-8.3A1.5 1.5 0 0 0 16.9 4H7.1a1.5 1.5 0 0 0-1.5 1.2Z"
    ],
    info: [
        "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z",
        "M12 11.5v5",
        "M12 7.8h.01"
    ],
    warning: [
        "M10.3 4.3 2.9 17.2A1.5 1.5 0 0 0 4.2 19.2h15.6a1.5 1.5 0 0 0 1.3-2L13.7 4.3a1.5 1.5 0 0 0-2.6 0Z",
        "M12 9.5v4",
        "M12 16.8h.01"
    ],
    bolt: ["m13 3-8 10h6l-1 8 8-10h-6l1-8Z"],
    // A streak: consecutive days. Named for what it means rather than what it
    // decorates, and drawn as a flame because that is the one mark every reader
    // already reads as "you have kept this going".
    flame: [
        "M12 3c2.5 3 4 5 4 7.5A4 4 0 0 1 12 15a4 4 0 0 1-4-4.5C8 8 9.5 6 12 3Z",
        "M12 21a6 6 0 0 0 6-6c0-2.5-1.5-4-3-5.5"
    ]
};

// Names whose direction is relative to the reader rather than to the page. These
// get the `icon-flip` class, and one rule in base.css mirrors it when the
// document is RTL ظ¤ so both languages are served by a single drawing, and the
// mirror follows the `dir` attribute rather than anything JavaScript has to
// re-apply when the language changes.
const FLIPPED = new Set(["back", "forward", "chevronRight", "undo"]);

// The only sanctioned way to put an icon on screen. `name` must be a key of
// ICONS; an unknown name is a programming error and throws rather than drawing
// an empty box, so a typo fails at the first render instead of silently
// producing a gap in a row.
export function uiIcon(name, { className = "icon", size = null, flip = null } = {}) {
    const paths = ICONS[name];
    if (!paths) throw new Error(`uiIcon: unknown icon "${name}"`);
    const mirrored = (flip ?? FLIPPED.has(name)) ? " icon-flip" : "";
    return icon(paths, { className: `${className}${mirrored}`.trim(), size });
}

// ------------------------------------------------- the two grouped sets ----

// The destinations, by name — keyed by the path they navigate to, which is also
// the route table in main.js and the layer list in ui/components/nav.js, so a new
// destination needs a name here and nowhere else.
//
// The ORDER is the order of priority and it has to match nav.js's DESTINATIONS
// item for item, because the two are read by the same list from two directions:
// this one says which shape a destination is drawn with, that one says when it
// matters. There is no viewport at which this map fits across the top of a
// screen, so nothing renders it as a strip — the header's button and the menu it
// opens read it one row at a time, in this order.
//
// `/more` is last because it is not a destination but the MENU: the same glyph the
// header's button wears, three lines, because it is a list of what is in the list.
export const NAV_ICON_NAMES = {
    "/": "home",
    "/tasks": "tasks",
    "/routines": "repeat",
    "/later": "bookmark",
    "/finance": "wallet",
    "/pages": "file",
    "/kanban": "kanban",
    "/sessions": "clock",
    "/log": "history",
    "/reports": "chart",
    "/settings": "sliders",
    "/more": "menu"
};

// The two money directions, by name. The home screen's shortcuts, the share
// chooser and the transaction form's type picker all ask for these by name, so
// the arrow on the form and the arrow on the shortcut are the same drawing by
// construction rather than by three copies agreeing.
export const MONEY_ICON_NAMES = {
    income: "moneyIn",
    expense: "moneyOut"
};
