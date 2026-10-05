// The cache name carries the app version ON PURPOSE. With a fixed name the
// `activate` handler below can never clear anything — it only deletes caches
// whose name differs from CACHE, and CACHE never differs from itself — so a
// browser kept serving the bundle from the release it first installed, and a
// rebuilt fix appeared to have no effect.
//
// Bumping the version here (together with APP_VERSION in app/js/config.js,
// which tests/config.test.mjs keeps equal to package.json) gives every release
// its own cache, and the previous one is deleted on activation.
//
// The build's asset names carry a content hash, so a release that changes no
// version number still asks the network for a file it has never seen — the
// staleness this file exists to defeat is gone. What a version bump still buys
// is the sweep: the previous release's hashed assets stay in the cache until
// the next one deletes the whole thing, which is the right trade for a handful
// of files on a device that is usually offline anyway.
const CACHE = "task-timer-v1.3.0";

// The ONE key the app shell is filed under, whatever path the navigation that
// fetched it happened to use.
//
// It exists because the fallback lookup below can only find the shell under a
// key somebody wrote it to, and before this the only writes were the pathname
// of whatever navigation happened to be online at the time: `/` for a user, and
// nothing at all for a deep link or the share-target launch — `cacheable()`
// refuses to file those, correctly, because a deep link is the same public
// document and forty copies of it is forty copies of the app in a store nothing
// evicts. So "the shell is cached" and "the shell is findable" were two
// different questions, and only one of them had an answer.
//
// Naming the key here makes the offline answer a lookup of exactly one thing.
const SHELL = "/index.html";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
])));

// WHAT MAY BE CACHED — an allowlist of the offline app, and nothing else.
//
// This is deliberately a list of the things the app needs to boot with no
// network, rather than a list of things it must not cache. An allowlist is the
// only version of this rule that stays true as the app grows: a deny-list has to
// be right about every request the app will ever make, and one forgotten entry
// is a copy of a user's account sitting in Cache Storage — which, unlike a
// response cache, nothing evicts but a new release and nothing scopes but the
// origin. So: no API response, no account screen, no settings page, no anything
// not named here can be stored, today or after the next feature.
//
// `/api/` is therefore excluded twice over, once by the allowlist and once by an
// explicit guard, because the API is the one path where per-session data lives
// and the guard is what states that as a rule rather than as a consequence.
//
// Note what is NOT here, and why: the app's own responses are served with
// `Cache-Control: no-store` for the two files that must never be reused — this
// worker and the shell (see docker-router.php and docker/nginx). That header is
// aimed at the BROWSER's HTTP cache, one layer below this worker, and refusing
// to cache because of it would silently delete offline support — the app is
// `no-store` precisely so that a rebuilt shell is picked up, while this cache is
// what makes a device with no network still open the app. Those are two
// different caches with two different jobs.
//
// The hashed assets under /dist/ are the other half of that arrangement: their
// names carry the hash of their content, so both servers keep them for a year
// and this worker stays network-first without paying for a revalidation round
// trip on a file whose name already says whether it changed.
const OFFLINE_PREFIXES = ["/dist/", "/icons/"];

function cacheable(request) {
    const url = new URL(request.url);
    if (url.origin !== location.origin) return false;
    if (url.pathname.startsWith("/api/")) return false;
    if (url.pathname === SHELL || url.pathname === "/") return true;
    if (url.pathname === "/manifest.webmanifest") return true;
    return OFFLINE_PREFIXES.some(prefix => url.pathname.startsWith(prefix));
}

// WHETHER A RESPONSE IS THE APP — the question that was missing, and the one
// whose absence is the blank window.
//
// The handler below used to treat "fetch() did not throw" as "fetch() returned
// the app". Those are not the same statement, and on the network this app is
// served from the difference is the whole bug: a reverse proxy in front of a
// home server answers 502, a host mid-deploy answers 503, a captive portal
// answers 302 to a login page, and an unbuilt checkout answers 503 with a page
// that says to run `npm run build`. Every one of those is a RESOLVED fetch. The
// old code stored nothing (status was not 200) and then handed the error
// straight to the page, so the installed app's window filled with a proxy's
// error page or with nothing at all, and there was nothing to retry from — the
// shell was sitting in Cache Storage the whole time, unreachable, because the
// `.catch()` that looks there was only ever reached by a request that failed to
// leave the device.
//
// A browser tab hides this: the user presses reload again and either it works or
// it does not, and a tab has an address bar and a refresh button to reach for.
// An installed app has neither, so the same transient server hiccup reads as
// "the app is broken and my data is gone". Pull-to-refresh is where it shows up
// most, because that is the gesture people use when they can already tell
// something is wrong.
//
// So a response is only the app if it is OK, and — for a navigation — if it is
// actually a document. The content-type check is not pedantry: a captive portal
// and several proxies answer with 200 and their own HTML, and a shell swapped
// for a proxy's login form is a white page with a password box on it.
function usable(r, navigation) {
    // An opaque or unfollowed-redirect response carries no status and no readable
    // body. It is never this app, whatever its URL says.
    if (r.type === "opaque" || r.type === "opaqueredirect") return false;
    if (!r.ok) return false;
    if (!navigation) return true;
    const type = (r.headers.get("content-type") || "").toLowerCase();
    return type.includes("text/html") || type.includes("application/xhtml+xml");
}

// Write a response, and file the shell under its one canonical key as well.
//
// The put is AWAITED, which the fire-and-forget version was not, and that is
// the difference between "the shell is cached" and "the shell is still being
// cached when the page goes away". A reload throws the old document away
// immediately, and an un-awaited `caches.open().then(put)` is very often killed
// with it — so the one moment the cache is most needed is the moment it was
// least likely to be written.
//
// Both clones are taken before either put is called: a Response can only be
// cloned while its body is still unread, and `cache.put` starts reading as soon
// as it is handed one.
async function store(request, response, navigation) {
    try {
        const a = response.clone();
        const b = navigation ? response.clone() : null;
        const cache = await caches.open(CACHE);
        await cache.put(request, a);
        // One public document, filed once. The request that brought it in may be
        // `/`, `/index.html`, `/tasks` or `/share?title=…`; they are all the same
        // bytes and only one of them is worth keeping.
        if (b) await cache.put(SHELL, b);
    } catch {
        // A full quota, a private-mode refusal, a browser that closed the cache
        // underneath us. None of that is a reason to fail the navigation the
        // response was already fetched for.
    }
}

self.addEventListener("fetch", e => {
    if (e.request.method !== "GET") return;
    if (new URL(e.request.url).origin !== location.origin) return;
    if (new URL(e.request.url).pathname.startsWith("/api/")) return;

    // A NAVIGATION is a request for the app shell whatever the path says — the
    // app is one document and the router picks the view from the URL — so every
    // navigation is answered here, including one at a path that is not on the
    // allowlist. What may be STORED stays allowlisted, one line below: a deep
    // link is the very same public shell as `/`, so caching it once per route
    // would put app paths in Cache Storage for no gain, and the cache is the one
    // store on the device that nothing ever evicts.
    const navigation = e.request.mode === "navigate";
    const storable = cacheable(e.request);
    if (!navigation && !storable) return;

    // Network-first, so a deployed update is picked up on the next load. The
    // response is still written to the cache for offline use.
    e.respondWith((async () => {
        // `null` means the network never answered, and it is kept distinct from
        // "the network answered with something that is not the app" only so the
        // comment above has something true to point at — both land in the cache
        // below, which is the entire behaviour change.
        let r = null;
        try {
            r = await fetch(e.request);
        } catch {
            r = null;   // offline, or the request never left the device
        }

        if (r && usable(r, navigation)) {
            if (r.status === 200 && storable) await store(e.request, r, navigation);
            return r;
        }

        // A miss stays a miss for an ASSET, and serving the shell in answer to a
        // failed request for a built asset hands the browser HTML to parse as
        // JavaScript, so an offline asset miss surfaces as a syntax error
        // pointing at the wrong file. A copy we DO hold is better than either:
        // the name is content-hashed, so a held copy is the right bytes.
        if (!navigation) {
            const held = await caches.match(e.request, { ignoreSearch: true });
            if (held) return held;
            return Response.error();
        }

        // The shell is one document filed under SHELL, but the lookup still
        // starts at the requested path: a shell cached under `/` by an older
        // release of this worker is still a shell, and this is what finds it
        // during the one load that happens before the canonical write.
        // `respondWith(undefined)` renders an empty document, with no error
        // anywhere, and the app looks like it simply did not start — so a real
        // miss is reported as a miss instead.
        for (const key of [e.request, SHELL, "/"]) {
            const m = await caches.match(key, { ignoreSearch: true });
            if (m) return m;
        }
        return Response.error();
    })());
});

// Tapping a notification.
//
// There is exactly one kind of notification in this app — "the running session
// reached its estimate" — and exactly one useful thing to do with it, which is
// why this is not a push handler and why there is no payload to route: the
// destination is part of the message, not part of the program.
//
// An open window is ASKED to go there rather than being replaced by a new one.
// A timer is a single-window thing; a second window of it, opened behind the
// first, is two sessions' worth of confusing state, and a phone that is already
// showing the app does not need a third card in the app switcher. So the message
// asks (main.js owns the only router in the app and is the only thing that can
// change the address), and a window is only OPENED when there is none — which is
// what happens after the app was closed and the alert is the only trace of it
// that is left.
self.addEventListener("notificationclick", e => {
    e.notification.close();
    const url = e.notification.data?.url || "/session";
    e.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const client of windows) {
            if (new URL(client.url).origin !== location.origin) continue;
            client.postMessage({ type: "open-session" });
            return client.focus();
        }
        return self.clients.openWindow(url);
    })());
});
