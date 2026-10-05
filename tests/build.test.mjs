import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// The build, and the two servers that serve it.
//
// The failure this file exists for is a silent one. `app/index.html` used to
// name `/dist/bundle.js` and `/dist/styles.css` by hand, and the two servers
// disagreed about those exact paths on purpose: docker-router.php sent
// `no-store` because a fixed name cannot be cached, and nginx sent `expires 1y`
// because built assets normally are. Both were reasoning about a build that
// cannot be produced by the config that was in front of them, so a fix shipped
// in a rebuild reached one deployment and not the other, and nothing failed —
// the app simply kept running last month's code on half the servers.
//
// So the rules are now stated once, in the build, and asserted here:
//
//   1. The shell is generated. It names no asset of its own, so it can only
//      reference what this build produced.
//   2. Emitted names carry the hash of their content, which is what makes a
//      year of caching correct and a rebuild reach every client.
//   3. Both servers implement that same policy, and both refuse the sources.
//   4. What is emitted is minified — because "encrypted" for a file the browser
//      must execute is minification and nothing more, and the JavaScript half
//      of that had been true for a while while the CSS half had not.

const root = fileURLToPath(new URL("..", import.meta.url));
const read = p => readFileSync(join(root, p), "utf8");
const distDir = join(root, "app/dist");
const built = existsSync(distDir);

/** Emitted files, by extension. Names are content-hashed, so select by shape. */
const emitted = ext => built
    ? readdirSync(distDir).filter(n => ext.test(n)).sort()
    : [];

// ------------------------------------------------------- 1. the shell is built

test("the template names no asset, so the shell can only reference what was built", () => {
    // A hand-written <link> or <script src> in the template is how a stale
    // reference gets in: it survives every rebuild, and it is the one URL the
    // page loads that no build output is responsible for. The build injects
    // both, so the template must contain neither. Comments are stripped first:
    // the template explains what the build does to it, and explaining it in a
    // comment is not the same as doing it.
    const template = read("app/index.html").replace(/<!--[\s\S]*?-->/g, "");
    assert.ok(!/<link[^>]+rel=["']?stylesheet/i.test(template),
        "app/index.html must not hardcode a stylesheet — the build injects it");
    assert.ok(!/<script[^>]+src=/i.test(template),
        "app/index.html must not hardcode a script — the build injects it");
    assert.ok(!template.includes("/dist/"),
        "app/index.html must not name any /dist/ URL at all");
});

test("the built shell references exactly the assets that were emitted", { skip: !built && "run npm run build" }, () => {
    const shell = read("app/dist/index.html");

    // Every /dist/ URL the page asks for must be a file on disk. This is the
    // check that would have caught a renamed or unhashed asset the moment the
    // build changed, instead of on a user's phone.
    const asked = [...shell.matchAll(/\/dist\/[^"'\s>]+/g)].map(m => m[0]);
    assert.ok(asked.length >= 2, `the shell asks for the bundle and the stylesheet (${asked.length})`);
    for (const url of asked) {
        assert.ok(existsSync(join(root, "app", url)),
            `the shell asks for ${url}, which the build did not emit`);
    }

    // One stylesheet, one script, and no hand-written tag that survived.
    assert.equal((shell.match(/rel=["']?stylesheet["']?/g) || []).length, 1);
    assert.equal((shell.match(/<script/g) || []).length, 1);

    // And the CSP, which is a meta tag in the template, survived minification.
    // A shell without it would load and then be refused by the browser.
    assert.match(shell, /Content-Security-Policy/);
    // …as did the two tags the iOS install path depends on.
    assert.match(shell, /apple-mobile-web-app-title/);
    assert.match(shell, /mobile-web-app-capable/);
});

// ---------------------------------------------------- 2. the names carry a hash

test("every emitted asset is named after the hash of its own content", { skip: !built && "run npm run build" }, () => {
    const assets = emitted(/^(?!\.|\.map$)/).filter(n => /\.(js|css)$/.test(n));
    assert.ok(assets.length > 0, "the build emitted something");
    for (const name of assets) {
        assert.match(name, /^app\.[0-9a-f]{8}\.(js|css)$/,
            `${name} must be app.<contenthash>.js|css — a fixed name cannot be cached for a year`);
    }
    // One script and one stylesheet, and both are named after the same build.
    assert.equal(assets.filter(n => n.endsWith(".js")).length, 1);
    assert.equal(assets.filter(n => n.endsWith(".css")).length, 1);
});

test("a rebuild of unchanged sources keeps the names, and a change moves them", { skip: !built && "run npm run build" }, () => {
    // The property that makes a content hash worth having: the name is a
    // function of the content and of nothing else. It cannot be checked by
    // reading files here, so what IS checked is that the two properties that
    // break it — a timestamp or a random salt in the name — are absent from the
    // config that mints the names.
    const config = read("webpack.config.js");
    assert.match(config, /\[contenthash:8\]/, "the hash is what the names are built from");
    for (const nondeterministic of [/[Mm]d5|Date\.now|randomUUID|Math\.random/]) {
        assert.ok(!nondeterministic.test(config),
            `webpack.config.js must not put ${nondeterministic} in an asset name — a name that changes every build cannot be cached`);
    }
});

// ------------------------------------------------- 3. what ships is minified

test("what ships is minified, in both halves", { skip: !built && "run npm run build" }, () => {
    // The honest form of "encrypted the output": the browser has to execute
    // this, so it cannot be encrypted — anything that decrypted at runtime would
    // ship the key next to the ciphertext. What is available is minification
    // and identifier mangling, and the JavaScript half already had it while the
    // extracted stylesheet did not: `optimization.minimize` only ever touched
    // JavaScript, so 87 KB of CSS shipped with every comment in it.
    const css = emitted(/\.css$/).map(n => read(`app/dist/${n}`));
    const js = emitted(/\.js$/).map(n => read(`app/dist/${n}`));
    assert.ok(css.length && js.length, "both halves were emitted");

    for (const src of css) {
        assert.ok(!/\/\*[\s\S]*?\*\//.test(src), "the stylesheet keeps no comments");
        assert.ok(!/\n\s*\n/.test(src), "the stylesheet keeps no blank lines");
        assert.ok(!/\s*:\s*;/.test(src), "the stylesheet keeps no empty declarations");
        // One declaration per line at most: a minified sheet has no indentation.
        assert.ok(!/^\s+/m.test(src), "the stylesheet is not indented");
    }

    const sources = ["app/css/tokens.css", "app/css/base.css", "app/css/layout.css", "app/css/components.css"]
        .map(f => statSync(join(root, f)).size)
        .reduce((a, b) => a + b, 0);
    const shipped = css.reduce((a, s) => a + Buffer.byteLength(s), 0);
    assert.ok(shipped < sources * 0.75,
        `the stylesheet should be well under the size of its sources (${shipped} vs ${sources} bytes)`);

    for (const src of js) {
        assert.ok(!/^\/\//m.test(src), "the bundle keeps no line comments");
        // A mangled bundle has no `function name(` longer than a couple of
        // characters, which is the cheapest honest signal that it was minified.
        const longNames = src.match(/\bfunction\s+[A-Za-z_$][A-Za-z0-9_$]{6,}\s*\(/g) || [];
        assert.equal(longNames.length, 0,
            `the bundle keeps unminified function names: ${longNames.slice(0, 3).join(", ")}`);
    }
});

// ------------------------------------------- 4. the two servers agree, and refuse

test("both servers cache a hashed asset for a year", () => {
    // The disagreement this replaces: `no-store` in the router, `expires 1y` in
    // nginx, on the same paths, for the same assets. The rule now lives in one
    // place — the names are hashed — so both may say "a year" and both be right.
    const router = read("docker-router.php");
    const nginx = read("docker/nginx/default.conf");

    assert.ok(router.includes(String.raw`^/dist/[^/]*\.[0-9a-f]{8}\.(?:js|css)$#`),
        "the router gives a year only to a name that carries a hash");
    assert.ok(router.includes("public, max-age=31536000, immutable"));
    assert.ok(nginx.includes(String.raw`location ~ "^/dist/[^/]*\.[0-9a-f]{8}\.(?:js|css)$"`),
        "nginx matches the hashed name too, and not the bare prefix");
    assert.match(nginx, /expires 1y;/);
    // THE QUOTES AROUND THAT PATTERN ARE LOAD-BEARING, and this assertion is the
    // cheap half of the check — the real one is `nginx -t` in the running
    // container, because nginx's config parser reads `{` as the start of a block
    // even inside a `location ~` pattern. Unquoted, the file below shipped that
    // way and nginx refused to start at all:
    //
    //   [emerg] unknown directive "8}\.(?:js|css)$" in .../default.conf
    //
    // No test could have seen it: this is the only line in the repository that
    // nginx's own parser reads, and docker-router.php implements the same policy
    // in PHP. Asserted anyway, because the mistake is a one-character edit away
    // and the failure mode is a container that will not boot.
    assert.ok(!nginx.includes(String.raw`location ~ ^/dist/[^/]*\.[0-9a-f]{8}`),
        "a `location ~` pattern containing `{` must be quoted for nginx");
    // The trap that makes the nginx rule a lie: a `^~` prefix location stops
    // nginx evaluating regex locations at all, so the fallback below the hashed
    // one must not carry it.
    assert.ok(!/location \^~ \/dist\//.test(nginx),
        "the /dist/ fallback must be a plain prefix or it pre-empts the hashed rule");
});

test("nginx says no-cache on every address the shell is opened at", () => {
    // Measured in the running container, and the reason this test exists: `/tasks`
    // and a direct `/dist/index.html` answered `no-cache`, while `/` and
    // `/index.html` answered with no `Cache-Control` at all. The internal
    // redirect through `try_files` did not carry the header over, so the shell's
    // whole policy depended on an inheritance that does not happen — on the two
    // addresses a user is most likely to type.
    //
    // `expires -1` rather than `add_header`, because a location that uses
    // `add_header` discards every `add_header` it would otherwise inherit, and
    // the security headers are inherited from the server block.
    const nginx = read("docker/nginx/default.conf");
    for (const location of [/location = \/ \{[\s\S]*?\n    \}/, /location = \/index\.html \{[\s\S]*?\n    \}/]) {
        const block = location.exec(nginx);
        assert.ok(block, "the shell is served from an exact location");
        assert.match(block[0], /expires -1;/,
            "an exact location serving the shell must state its own revalidation");
    }
    // …and the file it redirects to, which is what the catch-all lands on.
    assert.match(nginx, /location = \/dist\/index\.html \{[\s\S]*?expires -1;/);
});

test("both servers refuse to reuse the shell", () => {
    const router = read("docker-router.php");
    const nginx = read("docker/nginx/default.conf");
    for (const [name, src] of [["docker-router.php", router], ["docker/nginx", nginx]]) {
        assert.ok(/index\.html/.test(src) && /no-store|expires -1/.test(src),
            `${name} must keep the shell out of any cache`);
    }
    // The shell is the built one, in both: a server that answered `/` with the
    // template would serve a page that loads nothing at all.
    assert.match(router, /TT_SHELL_REL = '\/dist\/index\.html'/);
    assert.match(nginx, /try_files \/dist\/index\.html =404;/);
    // …and the template itself is never served under its own name.
    assert.match(nginx, /location = \/index\.html \{/);
});

test("neither server hands out the unbuilt sources", () => {
    // app/js and app/css are in the document root because the bundle is built
    // from them, and the built page references nothing in them. Serving them is
    // free readable source — 107 unminified modules — for a deployment that gets
    // nothing back for it.
    const router = read("docker-router.php");
    const nginx = read("docker/nginx/default.conf");
    assert.match(router, /str_starts_with\(\$path, '\/js\/'\)/);
    assert.match(router, /str_starts_with\(\$path, '\/css\/'\)/);
    assert.match(nginx, /location \^~ \/js\/ \{ return 404; \}/);
    assert.match(nginx, /location \^~ \/css\/ \{ return 404; \}/);
    // The service worker's allowlist must not have grown to compensate.
    const sw = read("app/sw.js");
    assert.ok(!sw.includes('"/js/"') && !sw.includes('"/css/"'),
        "the sources are not offline assets and must not be in the cache allowlist");
});

test("the SPA fallback resolves to the built shell in every serving path", () => {
    // Three ways this app is served, one answer: the built shell.
    const router = read("docker-router.php");
    const nginx = read("docker/nginx/default.conf");
    // docker-router.php: /, /index.html and an unmatched path.
    assert.match(router, /\$path === '\/' \|\| \$path === '\/index\.html'/);
    assert.match(router, /readfile\(\$shell\)/);
    // nginx: the root, the named file, and the catch-all.
    assert.match(nginx, /location = \/ \{/);
    assert.match(nginx, /location = \/index\.html \{/);
    assert.match(nginx, /try_files \$uri \$uri\/ \/dist\/index\.html;/);
    // The static hosts, through app/_redirects.
    assert.match(read("app/_redirects"), /\/dist\/index\.html\s+200/);
    // An `index` directive would answer `/` with the template at the docroot
    // root, which exists — that is the one line that would undo all of this.
    assert.ok(!/^\s*index\s+m?html/im.test(nginx), "no `index` directive: it serves the template for `/`");
});

test("an offline navigation finds the shell under every key it can be stored at", () => {
    // The same "one answer, every path" question, asked from the other side: with
    // no network, the service worker is the only thing that can answer, and it
    // answers from Cache Storage — where the shell is filed under the pathname
    // the online navigation happened to use, which is `/` for a user and
    // `/index.html` only for a host or a bookmark that names it. A deep link is
    // the same public document and is never filed at all.
    //
    // Measured in a browser with the server stopped: the cache held `/` and not
    // `/index.html`, so a fallback that named `/index.html` alone resolved to
    // nothing, and `respondWith(undefined)` renders an empty document — no
    // console error, no failed request, an app that looks like it did not start.
    const sw = read("app/sw.js");

    // Every navigation is answered, not only the paths on the cache allowlist.
    assert.match(sw, /const navigation = e\.request\.mode === "navigate"/,
        "a navigation is a request for the shell whatever the path says");
    assert.match(sw, /if \(!navigation && !storable\) return;/,
        "only the allowlist gates what is STORED, not what is answered");

    // And the offline answer looks under all of: itself, the shell's own key,
    // and `/`. The middle one is named by the constant rather than as a literal,
    // because the constant is what the write below uses — two spellings of one
    // key would be two things to keep in step.
    assert.match(sw, /const SHELL = "\/index\.html";/,
        "the shell is filed and looked for under one named key");
    const keys = /for \(const key of \[(.*?)\]\)/.exec(sw);
    assert.ok(keys, "the offline shell lookup is an ordered list of keys");
    for (const key of ["SHELL", '"/"']) {
        assert.ok(keys[1].includes(key), `the lookup must include ${key}`);
    }
    assert.ok(keys[1].includes("e.request"),
        "the lookup starts at the requested path, so a shell cached as a deep link is found");
    // The shell is a valid answer to a NAVIGATION and to nothing else. Widening
    // the lookup without this guard would hand HTML to the parser as JavaScript
    // on an asset miss — which is likelier than it was, because a new release
    // asks for a hashed name no cache has ever seen.
    const guard = sw.indexOf("if (!navigation) {");
    assert.ok(guard > -1, "a failed ASSET request answers with an error, not with the shell");
    assert.ok(guard < sw.indexOf("for (const key of ["),
        "the guard comes before the shell lookup, not after it");
    assert.match(sw, /return Response\.error\(\);/,
        "a genuine miss stays a miss rather than answering with undefined");
    // Storing stays allowlisted: a deep link must not be written under its own
    // path just because it is now answered.
    assert.match(sw, /if \(r\.status === 200 && storable\)/,
        "only an allowlisted response is written to Cache Storage");
});

test("an error response from the network is never handed to the page", () => {
    // The blank installed window. Measured on this app: with the origin up the
    // service worker cached `/`, `/dist/app.<hash>.js` and `/dist/app.<hash>.css`,
    // and with the origin then answering 502 every route rendered a document with
    // no title, no `#app` and no content — the app that had been working a moment
    // earlier, gone, until the user opened it in a browser tab and reloaded.
    //
    // The cause is that "fetch() resolved" and "fetch() returned the app" were
    // treated as one statement. They are not. A reverse proxy in front of a home
    // server answers 502; a host mid-deploy answers 503; an unbuilt checkout
    // answers 503 with a page telling you to run `npm run build`; a captive
    // portal answers 200 with its own HTML. Every one of those RESOLVES, and the
    // handler stored nothing (the status was not 200) and then returned them
    // anyway — so the `.catch()` that looks in Cache Storage was only ever
    // reachable by a request that failed to leave the device.
    //
    // A browser tab hides this: the user presses reload again and either it works
    // or it does not, and a tab has an address bar and a refresh button. An
    // installed app has neither, so the same transient hiccup reads as "the app
    // is broken and my data is gone".
    const sw = read("app/sw.js");

    assert.match(sw, /function usable\(r, navigation\)/,
        "whether a response IS the app is a question with a name");
    assert.match(sw, /if \(!r\.ok\) return false;/,
        "a 4xx/5xx is a server that is unwell, not a document to render");
    assert.match(sw, /r\.type === "opaqueredirect"/,
        "an opaque or unfollowed redirect carries no status and is never this app");
    assert.match(sw, /type\.includes\("text\/html"\)/,
        "a navigation must be answered with a document — a proxy's 200 login page is not one");
    // …and the two must be reached from ONE place, before anything is stored or
    // returned. A `usable()` that exists but is never consulted is the old bug.
    assert.match(sw, /if \(r && usable\(r, navigation\)\) \{/,
        "nothing is stored or returned before it has been checked");

    // An asset that 502s still must not be answered with the shell.
    assert.match(sw, /if \(!navigation\) \{\s*const held = await caches\.match/,
        "an asset falls back to a copy of ITSELF, which the content hash makes correct");
});

test("the shell is filed under one key, and the write is awaited", () => {
    // Two problems, one line of storage each.
    //
    // The key: `cacheable()` refuses to file a deep link or the share-target
    // launch, which is right — a deep link is the same public document as `/`,
    // and forty route-shaped copies of it is forty copies of the app in a store
    // nothing evicts. But it meant the only copy was filed under whatever
    // pathname happened to be online, so "the shell is cached" and "the shell is
    // findable" became two questions and only one had an answer. The share
    // launch — the one navigation that is never `/` — filed nothing at all.
    const sw = read("app/sw.js");
    assert.match(sw, /const SHELL = "\/index\.html";/, "the shell has one canonical key");
    assert.match(sw, /await cache\.put\(SHELL, b\);/,
        "a navigation response is also filed under that key, whatever path it arrived at");

    // The await: a reload throws the old document away at once, and the old
    // fire-and-forget `caches.open().then(put)` is regularly killed with it — so
    // the shell was least likely to be written on exactly the load that most
    // needed it.
    assert.match(sw, /async function store\(request, response, navigation\)/);
    assert.match(sw, /await store\(e\.request, r, navigation\);/,
        "the page waits for the cache write, so a reload cannot race it");
    // Both clones are taken before either put, because a Response cannot be
    // cloned once `cache.put` has started reading it.
    assert.match(sw, /const a = response\.clone\(\);\s*const b = navigation \? response\.clone\(\) : null;/,
        "both clones are taken up front, not one per put");

    // And a cache that refuses must not fail the navigation it was fetched for.
    assert.match(sw, /\} catch \{\s*\/\/ A full quota/,
        "a full quota is swallowed — the response is already on its way to the page");
});

test("the update reload does not fight a navigation the user just asked for", () => {
    // The worker checks for an update AS PART OF a navigation, and this one
    // skipWaiting()s and clients.claim()s, so a pull-to-refresh used to be
    // answered by the new worker taking the page over and the page reloading
    // itself a second time — inside the refresh gesture, on a phone, which is
    // indistinguishable from the app failing to open.
    //
    // The worker has already taken control by the time `controllerchange` fires,
    // so what is stale is only this document's bundle, and waiting costs nothing:
    // the next launch reads the new worker and the new assets.
    const src = read("app/js/app/sw-register.js");
    assert.match(src, /if \(aliveFor\(\) < \d+\) return;/,
        "a page that has only just loaded is left alone");
    assert.match(src, /if \(reloaded\) return;/,
        "and it reloads at most once, whatever else fires");

    // `updateViaCache` is the belt to the `no-store` brace on /sw.js: it is a
    // request option, so it holds on the engines that decided `Cache-Control:
    // no-store` did not apply to them — and a worker served from a stale cache is
    // one the browser stops re-reading, which is how a shipped fix reaches nobody.
    assert.match(src, /register\("\/sw\.js",\s*\{\s*updateViaCache: "none"\s*\}\)/,
        "the update check is asked to bypass the HTTP cache");
});

// ----------------------------- 5. the hosted server is the same server, again

test("the hosting config is the container's server, with app/ one directory down", () => {
    // The third serving path: nginx + PHP-FPM on a shared host, no Docker
    // (deploy/hosting-nginx.conf). It exists so a deployment is a file copy, and
    // it can only hold that promise if it decides the same things the container
    // does. These are the decisions that are one edit away from diverging — the
    // same four the container's own tests above pin down.
    const hosted = read("deploy/hosting-nginx.conf");
    // Only the second server block is this app's server; the first is the
    // panel's front proxy, and it has a `location /` of its own.
    const app = hosted.slice(hosted.indexOf("# ---------- app server"));
    assert.ok(app.length > 0, "the file has the app server block");

    // The same year, for the same names, matched by hash and not by prefix.
    assert.ok(app.includes(String.raw`location ~ "^/dist/[^/]*\.[0-9a-f]{8}\.(?:js|css)$"`),
        "the hosted server matches the hashed name too, and not the bare prefix");
    assert.match(app, /expires 1y;/);
    assert.ok(!app.includes(String.raw`location ~ ^/dist/[^/]*\.[0-9a-f]{8}`),
        "a `location ~` pattern containing `{` must be quoted for nginx");
    assert.ok(!/location \^~ \/dist\//.test(app),
        "the /dist/ fallback must be a plain prefix or it pre-empts the hashed rule");

    // The same revalidation on the same three files, and the same 30 days on the
    // icons: the shell names the hashed assets, and a stored service worker is
    // one the browser stops re-reading.
    for (const [file, block] of [
        ["the shell", /location = \/dist\/index\.html \{[\s\S]*?\n  \}/],
        ["/sw.js", /location = \/sw\.js \{[\s\S]*?\n  \}/],
        ["the manifest", /location = \/manifest\.webmanifest \{[\s\S]*?\n  \}/],
    ]) {
        const found = block.exec(app);
        assert.ok(found, `${file} has its own location`);
        assert.match(found[0], /expires -1;/, `${file} is revalidated, not stored`);
    }
    assert.match(app, /location \^~ \/icons\/ \{[\s\S]*?expires 30d;/);

    // …and the shell is the BUILT one on every address it is opened at, which
    // on this layout means reaching into app/ rather than naming a root file.
    for (const block of [
        /location = \/ \{[\s\S]*?\n  \}/,
        /location = \/index\.html \{[\s\S]*?\n  \}/,
        /location \/ \{[\s\S]*?\n  \}/,
    ]) {
        const found = block.exec(app);
        assert.ok(found, "each address the shell is opened at has its own location");
        assert.match(found[0], /\/app\/dist\/index\.html/,
            "an in-app route is answered from the built shell, never the template");
        assert.match(found[0], /expires -1;/,
            "and it says its own revalidation rather than inheriting one");
    }
    // The rewrites that reach into app/ must stop in place. `last` would re-run
    // location matching and land on the `^~ /app/` refusal below, which answers
    // 404 — the site would serve nothing at all while every location looked right.
    for (const rewrite of app.match(/^\s*rewrite [^\n]*/gm) || []) {
        assert.match(rewrite, /break;$/,
            `a rewrite into app/ must use break, not last: ${rewrite.trim()}`);
    }

    // The refusals, under both this layout's names and the container's.
    assert.match(app, /location \^~ \/app\/ \{ return 404; \}/);
    assert.match(app, /location \^~ \/js\/ \{ return 404; \}/);
    assert.match(app, /location \^~ \/css\/ \{ return 404; \}/);
    const api = /location \^~ \/api\/ \{[\s\S]*?\n  \}/.exec(app);
    assert.ok(api, "nothing under /api/ is ever served as a file");
    assert.ok(!/try_files/.test(api[0]),
        "a try_files in front of the FastCGI pass would serve api/var/sync.sqlite off disk");
    // The API's own errors are JSON and have to arrive as JSON.
    assert.ok(!/fastcgi_intercept_errors\s+on/.test(app),
        "intercepting FastCGI errors would answer the client with an HTML error page");
    assert.match(api[0], /fastcgi_param SCRIPT_FILENAME \$document_root\/api\/index\.php;/);

    // The web manifest needs its type stated: most hosts' mime.types has no
    // entry for .webmanifest, and application/octet-stream fails the browser's
    // install criteria, so the app cannot be installed at all.
    assert.match(app, /application\/manifest\+json\s+webmanifest;/);
});

test("the hosted server recovers the client address without being able to forge it", () => {
    // Measured in a container, and the reason these are pinned: this deployment
    // has a front proxy in front of the app server, so REMOTE_ADDR at PHP is the
    // proxy on loopback unless the address is taken from the proxy's header — and
    // api/auth.php keys its per-IP failure budget on exactly that, so a missing
    // rule here does not fail loudly, it locks every client out together once ten
    // wrong passwords arrive from anywhere.
    const hosted = read("deploy/hosting-nginx.conf");
    const app = hosted.slice(hosted.indexOf("# ---------- app server"));

    assert.match(app, /set_real_ip_from 127\.0\.0\.1;/,
        "only the loopback proxy's word about the client is believed");
    assert.match(app, /real_ip_header X-Forwarded-For;/,
        "X-Forwarded-For, not X-Real-IP: behind Varnish the latter is the Varnish process");
    assert.match(app, /real_ip_recursive on;/,
        "a forged chain is prepended, so the right-most untrusted address is the real one");

    // The trap that makes the rule above look like a lockout: the access module
    // judges $remote_addr, which this module has ALREADY rewritten, so an
    // `allow 127.0.0.1; deny all;` written next to it denies every request that
    // arrives through the proxy — the whole site answering 403, with every
    // location in the file looking correct. Verified: that is what it does.
    assert.ok(!/^\s*(allow|deny)\s/m.test(app),
        "access rules and set_real_ip_from in one server block deny every proxied request");
    // HSTS is the other thing that is only safe in one of the two blocks: sent
    // from the plain-HTTP one, the browser caches it against the host and then
    // refuses every later plain-HTTP request to it.
    assert.match(hosted, /Strict-Transport-Security/);
    const tls = /add_header Strict-Transport-Security[^\n]*/.exec(hosted);
    assert.ok(tls && tls.index < hosted.indexOf("listen 8080"),
        "HSTS is sent by the block that terminates TLS, not by the plain-HTTP one");
});
