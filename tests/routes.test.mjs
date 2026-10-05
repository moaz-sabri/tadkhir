import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { DESTINATIONS, MORE_PATH } from "../app/js/ui/components/nav.js";

// The router's matcher, in the exact shape router.js uses. main.js cannot be
// imported here (it boots the app and touches IndexedDB and the DOM), so the
// table and the matcher are reproduced and held against each other: the point
// of these tests is that every path the app actually links to produces the
// params the page it points at reads.
import { PAGE_ITEM_ROUTES } from "../app/js/domain/pages.js";

const read = p => readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), p), "utf8");

const ROUTES = [
    "/",
    "/tasks",
    "/tasks/new",
    "/tasks/:id",
    "/sessions",
    "/sessions/:id",
    "/session",
    "/finance",
    "/finance/transactions",
    "/finance/transactions/new",
    "/finance/transactions/new/:type",
    "/finance/transactions/:id",
    "/finance/recurring",
    "/finance/recurring/new",
    "/finance/recurring/:id",
    "/finance/debts",
    "/finance/debts/new",
    "/finance/debts/:id",
    "/finance/categories",
    "/later",
    "/later/new",
    "/later/:id",
    "/pages",
    "/pages/:id",
    "/routines",
    "/routines/new",
    "/routines/:id",
    "/share",
    "/reports",
    // The Log is a tool over the services, and /more is the tail of the
    // destination list filed under its layers. Both are destinations in their own
    // right, so both are routes — a bar item that went nowhere would be a
    // destination with no screen behind it.
    "/log",
    "/more",
    "/settings",
    "/settings/install",
    "/404"
];

// Verbatim from app/js/app/router.js, including the guarded decode: the matcher
// has to survive a path it cannot decode, because a throw inside match() used to
// be reported by the boot sequence as "local storage is unavailable".
function decode(segment) {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

function match(path, routes = ROUTES) {
    for (const r of routes) {
        const keys = [];
        const re = new RegExp(
            "^" + r.replace(/:[^/]+/g, m => (keys.push(m.slice(1)), "([^/]+)")) + "/?$"
        );
        const m = path.match(re);
        if (m) {
            return {
                route: r,
                params: Object.fromEntries(keys.map((k, i) => [k, decode(m[i + 1])]))
            };
        }
    }
    return null;
}

test("the income shortcut reaches a route that supplies the type", () => {
    // The bug this guards: /finance/transactions/new/income was registered as a
    // literal path with no :type segment, so match() built no params and
    // params.type was always undefined. newTransaction then fell back to
    // "expense", and the home screen's "add income" button silently opened the
    // form pre-selected as an expense. Two literal paths cannot carry a value.
    for (const type of ["income", "expense"]) {
        const m = match(`/finance/transactions/new/${type}`);
        assert.ok(m, `no route matched /finance/transactions/new/${type}`);
        assert.equal(m.params.type, type);
    }
});

test("the plain new-transaction path still wins over the :type route", () => {
    // /new has to reach the form with no type at all, and it has to do so
    // before /:id can swallow it as an id called "new".
    const m = match("/finance/transactions/new");
    assert.equal(m.route, "/finance/transactions/new");
    assert.deepEqual(m.params, {});
});

test("a real id is not read as a type", () => {
    assert.equal(match("/finance/transactions/abc123").params.id, "abc123");
});

test("a literal segment is never read as a param", () => {
    // The inverse of the income bug: /tasks/new must not arrive as
    // { id: "new" }, which would try to edit a task called "new".
    assert.equal(match("/tasks/new").route, "/tasks/new");
    assert.equal(match("/later/new").route, "/later/new");
    assert.equal(match("/finance/recurring/new").route, "/finance/recurring/new");
    assert.equal(match("/finance/debts/new").route, "/finance/debts/new");
});

test("every screen a page item can open is a real route", () => {
    // A page holds pointers at records that live somewhere else, and the promise
    // of the feature is that tapping one opens the ORIGINAL. So the base address
    // for each linked kind, and the address of one real record through it, both
    // have to be routes — otherwise a page row links to a screen the router
    // would send to /404, and the only symptom is a tap that does nothing.
    //
    // This imports the domain module's table rather than repeating it: the map is
    // the feature's contract with the router, and a copy of it here could agree
    // with itself while the app pointed somewhere else.
    for (const [kind, base] of Object.entries(PAGE_ITEM_ROUTES)) {
        assert.ok(match(base), `no route matches the ${kind} list at ${base}`);
        const detail = match(`${base}/abc123`);
        assert.ok(detail, `no route matches a ${kind} record at ${base}/abc123`);
        assert.equal(detail.params.id, "abc123", `${kind} detail supplies no id`);
    }
});

test("a trailing slash is accepted and does not change the params", () => {
    assert.equal(match("/tasks/abc/").params.id, "abc");
});

test("a malformed percent escape does not throw", () => {
    // decodeURIComponent throws URIError on a bare "%". router.js guards it; this
    // is the shape of the input that guard exists for: a hand-typed or
    // bookmarked address that decodes to nothing rather than blowing up boot.
    assert.doesNotThrow(() => match("/tasks/%"));
    assert.equal(match("/tasks/%").params.id, "%");
});

test("every path the UI links to is a real route", () => {
    // Collected from the href values in app/js/ui and app/index.html.
    const linked = [
        "/", "/tasks", "/tasks/new", "/sessions", "/session", "/later", "/later/new",
        "/pages", "/routines", "/routines/new", "/log",
        "/finance", "/finance/transactions", "/finance/transactions/new",
        "/finance/transactions/new/income", "/finance/transactions/new/expense",
        "/finance/recurring", "/finance/recurring/new", "/finance/debts",
        "/finance/debts/new", "/finance/categories", "/reports", "/settings",
        "/settings/install", "/share", "/more"
    ];
    for (const path of linked) {
        assert.ok(match(path), `no route matches the linked path ${path}`);
    }
});

test("every destination the navigation offers is a real route", () => {
    // The bar, the header strip and the More sheet are three renderings of one
    // list, and the list is written by hand in nav.js while the routes are written
    // by hand in main.js. Nothing forces them to agree — so this reads both and
    // holds them against each other, which is the only way a destination with no
    // screen behind it can be caught before it ships.
    //
    // main.js cannot be imported here (it boots the app and touches IndexedDB and
    // the DOM), so the route table is read out of the source the same way the
    // matcher above is.
    const main = read("app/js/main.js");
    const routes = new Set([...main.matchAll(/\{\s*path:\s*"([^"]+)"/g)].map(m => m[1]));

    for (const path of [...DESTINATIONS, MORE_PATH]) {
        assert.ok(routes.has(path), `${path} is in the navigation but is not a route`);
    }
});
