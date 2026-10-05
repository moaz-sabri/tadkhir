// A tiny element factory — the whole UI is built with it, so its two sharp
// edges are worth writing down.
//
// `class` and `dataset` are handled explicitly, and `aria-*` / `data-*` go
// through setAttribute. Everything else is assigned as a property, which is
// right for `value`, `disabled`, `checked` and the rest — with one exception:
// ARIA *roles*. `el.role = "timer"` only reflects to the attribute on recent
// engines; on older ones it becomes an inert expando and the role is silently
// lost, which is exactly the kind of failure a screen reader never reports. So
// roles are set as attributes too, where every engine agrees.
//
// The `style` prop is the third exception, and the sharpest one. This app
// ships `Content-Security-Policy: style-src 'self'` — no `unsafe-inline` — so a
// `style` ATTRIBUTE is refused by the browser: `el.setAttribute("style", v)`
// writes the attribute, reports success, and leaves the element completely
// unstyled. That failure is invisible in every test and shows up only as a
// console line, which is exactly how a whole bar chart and a whole progress
// ring can render as blank boxes in production and still "pass".
//
// CSSOM is not covered by `style-src`. `el.style.setProperty()` and
// `el.style.cssText` are ordinary JavaScript property writes, and the browser
// applies them. So `style` is routed through the style object rather than
// through the attribute, and a caller can keep writing `style: "--fill: 40%"`
// without knowing any of this.
//
// `flash()` below is here for the same reason the factory is: it is a thing done
// to a built element, it needs no imports, and every component that wants it
// would otherwise write its own copy.

const ROLE_PROPS = new Set(["role"]);

export function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v == null) continue;
        if (k === "class") {
            el.className = v;
        } else if (k === "dataset") {
            Object.assign(el.dataset, v);
        } else if (k === "style") {
            // A string is a whole declaration list; an object is a set of
            // properties. Both go through the style object, never the attribute.
            if (typeof v === "string") el.style.cssText = v;
            else Object.assign(el.style, v);
        } else if (k.startsWith("aria-") || k.startsWith("data-") || ROLE_PROPS.has(k)) {
            // `false` is how a caller asks for the attribute to be absent, which
            // is different from `null`/`undefined` only in intent — both mean
            // "do not set it".
            if (v !== false) {
                el.setAttribute(k, v === true ? "" : String(v));
            }
        } else if (k.startsWith("on") && typeof v === "function") {
            el.addEventListener(k.slice(2).toLowerCase(), v);
        } else {
            el[k] = v;
        }
    }
    // flat() is depth-1, which is one level too few: every list in the app is
    // built by mapping over records, and a nested conditional would otherwise
    // be stringified into a literal "[object HTMLDivElement]".
    for (const c of children.flat(Infinity)) {
        if (c == null || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
}

// ------------------------------------------------------------------ flash ---

// One attribute, written and then taken back off, and the stylesheet decides
// what it looks like. That is the whole contract: a component that wants to say
// "this just changed" says so here and does not know the animation, its length,
// or whether motion is allowed at all.
//
// The stylesheet is where `prefers-reduced-motion` is honoured — the block in
// base.css collapses every animation in the app, this one included — so honouring
// it costs nothing here, and `element.animate()` was avoided precisely because it
// is outside that block and would have to re-check the media query by hand.
const FLASH_MS = 420;
const flashTimers = new WeakMap();

export function flash(element, kind, ms = FLASH_MS) {
    if (!element) return;
    const previous = flashTimers.get(element);
    if (previous) clearTimeout(previous);

    // A CSS animation only replays if the element stops matching its rule and
    // starts matching again, and the browser coalesces both changes if they land
    // in the same task — so the attribute comes off now and goes back on in the
    // next frame. Two flashes a few hundred milliseconds apart (which is the
    // only spacing that ever happens: each follows a state change) each get a
    // full animation.
    element.removeAttribute("data-flash");
    const view = element.ownerDocument?.defaultView;
    const nextFrame = view?.requestAnimationFrame
        ? fn => view.requestAnimationFrame(fn)
        : fn => setTimeout(fn, 16);
    nextFrame(() => {
        // A page that navigated away in the middle of a 420ms pulse does not get
        // to finish pulsing.
        if (element.isConnected !== false) element.setAttribute("data-flash", kind);
    });
    flashTimers.set(element, setTimeout(() => {
        element.removeAttribute("data-flash");
        flashTimers.delete(element);
    }, ms));
}
