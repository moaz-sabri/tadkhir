// A DOM small enough to build a real component in, and no smaller.
//
// It exists for one reason: `attachmentSection` decides whether a recording is
// DISPLAYED or merely DESCRIBED, and every test that used to cover it read its
// source and matched a regex. A regex cannot tell you whether the bytes land in
// the entry the grid draws, or whether the grid repaints when they arrive — it can
// only tell you that a line still looks the way it looked. So a bug in the one
// module that decides what the user sees was, by construction, invisible.
//
// This is not a DOM implementation and does not try to be. It is the smallest
// thing that runs `h()`, a form's submit handler, and a click: elements with
// children, classList, dataset, attributes, listeners, and a named-root lookup so
// `dialog.form` has somewhere to build into. Every gap is a gap a test does not
// need; if one turns out to be needed, it gets added here rather than worked
// around in the test.

class StubNode {
    constructor(tag) {
        this.tagName = String(tag || "").toUpperCase();
        this.nodeName = this.tagName;
        this.children = [];
        this.parentNode = null;
        this.className = "";
        this.dataset = {};
        this.style = {};
        this.attrs = {};
        this.listeners = {};
        this.textContent = "";
        this.hidden = false;
        this.disabled = false;
        // Form controls: the note form reads `.value` off every field it submits,
        // so a stub without one fails inside the submit handler rather than on the
        // screen the test is about.
        this.value = "";
        this.ownerDocument = globalThis.document;
        this.isConnected = true;
        this.classList = {
            add: (...c) => {
                const set = new Set(String(this.className || "").split(/\s+/).filter(Boolean));
                c.forEach(x => set.add(x));
                this.className = [...set].join(" ");
            },
            remove: (...c) => {
                const set = new Set(String(this.className || "").split(/\s+/).filter(Boolean));
                c.forEach(x => set.delete(x));
                this.className = [...set].join(" ");
            },
            contains: c => String(this.className || "").split(/\s+/).includes(c)
        };
    }

    append(...nodes) {
        for (const n of nodes) {
            n.parentNode = this;
            this.children.push(n);
        }
    }

    replaceChildren(...nodes) {
        this.children = [];
        this.append(...nodes);
    }

    setAttribute(k, v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k] ?? null; }
    hasAttribute(k) { return k in this.attrs; }
    removeAttribute(k) { delete this.attrs[k]; }
    // Descendant lookup by tag, which is all the dialog asks for when it moves
    // focus to its first field.
    querySelector(sel) {
        const want = String(sel).replace(/^\./, "").toUpperCase();
        return this.find(n => n !== this && (n.tagName === want
            || String(n.className || "").split(/\s+/).includes(want)))[0] || null;
    }
    querySelectorAll(sel) {
        const want = String(sel).replace(/^\./, "").toUpperCase();
        return this.find(n => n !== this && (n.tagName === want
            || String(n.className || "").split(/\s+/).includes(want)));
    }
    addEventListener(k, fn) { (this.listeners[k] ||= []).push(fn); }
    removeEventListener(k, fn) {
        this.listeners[k] = (this.listeners[k] || []).filter(x => x !== fn);
    }
    focus() {}
    click() {
        for (const fn of this.listeners.click || []) {
            fn({ stopPropagation() {}, preventDefault() {} });
        }
    }
    /** Fire a listener directly — how a test submits a form. */
    fire(type, event = {}) {
        for (const fn of this.listeners[type] || []) {
            fn({ stopPropagation() {}, preventDefault() {}, ...event });
        }
    }

    // Depth-first walk, and the one predicate the tests are written in terms of.
    all() {
        const out = [this];
        for (const c of this.children) if (c && c.all) out.push(...c.all());
        return out;
    }
    find(pred) { return this.all().filter(pred); }
    one(pred) { return this.find(pred)[0] || null; }
    byClass(name) { return this.find(n => String(n.className || "").split(/\s+/).includes(name)); }
    byTag(tag) { return this.find(n => n.tagName === String(tag).toUpperCase()); }
    /** The text a person would read, flattened out of the tree. */
    get text() {
        return this.children.map(c => (c.all ? c.text : String(c.textContent ?? ""))).join("");
    }
}

const roots = new Map();
const rootFor = selector => {
    if (!roots.has(selector)) roots.set(selector, new StubNode("div"));
    return roots.get(selector);
};

export function installStubDOM() {
    if (globalThis.__stubDOM) return;
    globalThis.__stubDOM = true;
    globalThis.Node = StubNode;
    globalThis.document = {
        createElement: tag => new StubNode(tag),
        createElementNS: (ns, tag) => new StubNode(tag),
        createTextNode: text => Object.assign(new StubNode("#text"), { textContent: String(text) }),
        // The dialog builds into `#dialog-root`, so it has to exist — otherwise
        // `dialog.form` takes its "there is no root" exit and the test proves
        // nothing about what the viewer drew.
        querySelector: sel => rootFor(sel),
        addEventListener() {},
        removeEventListener() {}
    };
    // Object URLs, and the two halves of the repaint loop the level meter drives.
    let n = 0;
    globalThis.URL.createObjectURL = () => `blob:stub/${++n}`;
    globalThis.URL.revokeObjectURL = () => {};
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};
}

export { StubNode, rootFor };