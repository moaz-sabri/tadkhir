import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { safeHref } from "../app/js/domain/rich-text.js";

// Static and structural guards on the browser half of the project.
//
// The API's own security suite lives in api/tests/security.php and drives a real
// server. This file covers the things that only a source-level check can assert
// cheaply, and that are the regressions most likely to creep back in:
//
//   1. No HTML sink. The entire reason user text has never been a markup
//      injection here is that no module has a way to create one. Losing that is
//      a single line, and no behavioural test would notice.
//   2. No secret in the source, and none in what the service worker is willing
//      to persist.
//   3. The service worker's cache is an app shell, never an API response.
//   4. The external-link policy is applied where external links are emitted.
//   5. Nothing that can act as a credential is written to IndexedDB or
//      localStorage.

const root = fileURLToPath(new URL("..", import.meta.url));
const read = p => readFileSync(join(root, p), "utf8");

/** Every .js under app/js, so a new file is covered without editing this. */
const jsFiles = [];
(function walk(dir) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (entry.name.endsWith(".js")) jsFiles.push(rel);
    }
})("app/js");

// The service worker is checked separately below; it fetches, but it never talks
// to the API, so it has no Content-Type to declare.
const allJs = jsFiles;
// Comments are prose about the design, and several of them quote the very things
// the scans below look for. Strip them so a note about the old code cannot fail
// a test about the new code.
const code = src => src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/**
 * The files a build emitted, selected by extension.
 *
 * The names are content-hashed (`app/dist/app.<hash>.js`), so anything that
 * checks the build output has to find it by shape — which is the point: a test
 * that hardcodes `bundle.js` is a test that quietly stops testing the build the
 * day the name changes, and it would have caught none of it.
 */
const builtFiles = ext => existsSync(join(root, "app/dist"))
    ? readdirSync(join(root, "app/dist")).filter(n => ext.test(n)).map(n => `app/dist/${n}`)
    : [];

// ------------------------------------------------------- 1. no HTML sink

test("no module can create an HTML sink", () => {
    // innerHTML, outerHTML, insertAdjacentHTML, document.write, eval and
    // new Function are the six ways user text becomes markup. dom.js builds
    // elements with createElement and turns every string child into a text node,
    // and this is the test that keeps it the only way.
    const banned = [
        /\.innerHTML\s*=/,
        /\.outerHTML\s*=/,
        /insertAdjacentHTML\s*\(/,
        /document\.write(ln)?\s*\(/,
        /\beval\s*\(/,
        /new\s+Function\s*\(/,
        /\.srcdoc\s*=/,
        /setAttribute\s*\(\s*["'](?:on[a-z]+|srcdoc)["']/i,
    ];
    for (const file of allJs) {
        const src = code(read(file));
        for (const pattern of banned) {
            assert.ok(
                !pattern.test(src),
                `${file} must not use ${pattern} — user text would become markup`
            );
        }
    }
});

test("the element factory can only build text nodes", () => {
    const dom = read("app/js/ui/dom.js");
    assert.match(dom, /document\.createElement\(tag\)/,
        "elements are created, never parsed from a string");
    assert.match(dom, /document\.createTextNode/,
        "a string child becomes a text node");
    assert.ok(!/\.innerHTML|\.outerHTML|insertAdjacentHTML/.test(code(dom)),
        "dom.js holds no HTML sink either");
});

test("the rich-text renderer only emits a closed set of tags", () => {
    // The tag choice is a switch over token kinds, and the default branch is
    // plain text. A token kind nobody taught it cannot become an element.
    const src = code(read("app/js/ui/components/rich-text.js"));
    const tags = [...src.matchAll(/h\(\s*"([a-z0-9]+)"/g)].map(m => m[1]);
    for (const tag of tags) {
        assert.ok(
            ["p", "div", "ul", "ol", "li", "blockquote", "br", "strong", "em", "s", "code", "a"].includes(tag),
            `"${tag}" is not in the documented tag set`
        );
    }
    assert.match(src, /default:/, "there is a default branch that renders text");
    assert.match(src, /rel:\s*"noopener noreferrer"/,
        "a link out of the app does not hand the new document a reference to this one");
});

test("an external link is checked against the link policy before it is emitted", () => {
    // A Later item's url is the one href in the app that is not a route this app
    // owns, and a Later record that arrived through sync or a restored backup is
    // not re-run through validateLaterUrl on its way into IndexedDB. ui.js is
    // where every <a href> is emitted, so that is where the check belongs.
    const src = code(read("app/js/ui/components/ui.js"));
    assert.match(src, /safeHref/,
        "the external href must go through safeHref");
    assert.match(src, /external\s*\?\s*safeHref\(/,
        "safeHref must guard the external case specifically");
});

test("the link policy allows only http, https and mailto", () => {
    for (const ok of ["https://a.dev/x", "http://a.dev", "mailto:a@b.dev"]) {
        assert.equal(safeHref(ok), ok, `${ok} is allowed`);
    }
    for (const bad of [
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        "  javascript:alert(1)  ",
        "data:text/html,<script>alert(1)</script>",
        "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
        "vbscript:msgbox(1)",
        "file:///etc/passwd",
        "blob:https://a.dev/x",
        "ftp://a.dev/x",
        // A newline in an href is how a URL smuggles a second attribute past a
        // naive sink; there is no such sink here, and the rule is one regex.
        "java\nscript:alert(1)",
        "java\tscript:alert(1)",
        "https://a.dev/\r\nX-Evil: 1",
    ]) {
        assert.equal(safeHref(bad), null, `${JSON.stringify(bad)} must not become a link`);
    }
    assert.equal(safeHref(""), null);
    assert.equal(safeHref(null), null);
    assert.equal(safeHref(undefined), null);
    assert.equal(safeHref(42), null);
});

test("a Later link is validated on the way in", () => {
    const v = read("app/js/domain/validation.js");
    assert.match(v, /parsed\.protocol !== "http:" && parsed\.protocol !== "https:"/,
        "a Later url must be http or https to be stored");
    // The record assertion is what covers records that arrive from sync or an
    // import rather than from the form.
    assert.match(v, /isHttpUrl\(r\.url\)/,
        "an imported or synced Later record is checked too");
});

test("a page pointer resolves to a route, never to a stored url", () => {
    const src = code(read("app/js/domain/pages.js"));
    const block = /PAGE_ITEM_ROUTES = Object\.freeze\(([\s\S]*?)\n\}\);/.exec(src);
    assert.ok(block, "PAGE_ITEM_ROUTES is a frozen literal");
    const routes = [...block[1].matchAll(/(\w+):\s*"([^"]*)"/g)].map(m => m[2]);
    assert.ok(routes.length >= 4, "the route table has an entry per pointer type");
    for (const base of routes) {
        assert.ok(base.startsWith("/"), `${base} is an in-app route`);
    }
    assert.ok(!routes.some(r => /^[a-z]+:/i.test(r)),
        "no pointer type resolves to an external scheme");
    // linkFor() builds the href from that table plus a record id. There is no
    // branch in it that could return something the table does not contain.
    const linkFor = /export function linkFor\(item\)[^{]*\{[\s\S]*?\n\}/.exec(src)[0];
    assert.ok(!/item\.(url|href|content\?\.url)/.test(linkFor),
        "linkFor must not read a url off the record");
});

// ------------------------------------------------------- 2. no secret in the source

test("no hardcoded credential, token or key is assigned anywhere", () => {
    // A literal assigned to a name that sounds like a secret. The i18n strings
    // legitimately contain the WORD "password" (they are labels for a password
    // field), so this looks at assignments to identifier-shaped names, not at
    // every occurrence of the word.
    const suspicious = [
        /(?:const|let|var)\s+(?:[A-Za-z_$][\w$]*(?:secret|token|password|passwd|apiKey|apikey|privateKey|credential)[A-Za-z_$]*)\s*=\s*["'`]([^"'`]{8,})["'`]/i,
        /(?:password|secret|token|apiKey|apikey|privateKey)\s*[:=]\s*["'`]([A-Za-z0-9+/=_\-]{16,})["'`]/i,
        /Bearer\s+[A-Za-z0-9._\-]{20,}/,
        /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
        /\bAKIA[0-9A-Z]{16}\b/,
        /\bghp_[A-Za-z0-9]{36}\b/,
        /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    ];
    for (const file of allJs) {
        const src = code(read(file));
        for (const pattern of suspicious) {
            const hit = pattern.exec(src);
            assert.ok(!hit, `${file} looks like it hardcodes a secret: ${hit?.[0].slice(0, 80)}`);
        }
    }
    const html = read("app/index.html");
    assert.ok(!/-----BEGIN|ghp_|xox[baprs]-|Bearer\s+[A-Za-z0-9._-]{20,}/.test(html),
        "app/index.html carries no credential");
});

test("no credential appears in the built bundle", () => {
    // The bundle's name carries a content hash, so it is found by shape rather
    // than by the name it used to have. The guard is the same one it always was:
    // what the browser receives must not carry a secret, hashed or not.
    const bundles = builtFiles(/\.js$/);
    if (bundles.length === 0) return;   // not built in this checkout
    for (const file of bundles) {
        const src = read(file);
        for (const pattern of [
            /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
            /\bghp_[A-Za-z0-9]{36}\b/,
            /Bearer\s+[A-Za-z0-9._\-]{20,}/,
        ]) {
            assert.ok(!pattern.test(src), `${file} must not contain ${pattern}`);
        }
        // The master key itself must never be a plain string in the bundle: it is a
        // non-extractable CryptoKey, and the only place it can live is a variable.
        assert.ok(!/"[0-9a-f]{64}"/.test(src),
            `no 64-hex-character string literal in ${file} (that shape is a session token)`);
    }
});

test("the deployment carries no committed database or local config", () => {
    // config.local.php is the only place a deployment-specific secret may live,
    // and it is gitignored. api/var/ holds the SQLite file and is gitignored too.
    const ignored = read(".gitignore");
    for (const must of ["api/config.local.php", "api/var/", "node_modules/"]) {
        assert.ok(ignored.includes(must), `.gitignore must cover ${must}`);
    }
    assert.ok(!existsSync(join(root, "api/config.local.php")),
        "api/config.local.php must not be committed");
    assert.ok(read("api/config.local.php.example").includes("config.local.php is gitignored"),
        "the example file says where real config belongs");
});

// ------------------------------------------------------- 3. service worker

test("the service worker caches an allowlist, and the API is not on it", () => {
    // The rule is an allowlist of the offline app, not a deny-list of what to
    // avoid. An allowlist is the only form that stays true as the app grows: one
    // forgotten entry in a deny-list is a copy of a user's account in Cache
    // Storage, which nothing evicts but a new release.
    const sw = read("app/sw.js");
    assert.match(sw, /const OFFLINE_PREFIXES = \[([^\]]*)\]/,
        "the cacheable set is a declared list");
    assert.match(sw, /pathname\.startsWith\("\/api\/"\)\)\s*return/,
        "/api/ is refused before the allowlist is even consulted");
    // And nothing under /api/ may be named in the allowlist.
    const list = /const OFFLINE_PREFIXES = \[([^\]]*)\]/.exec(sw)[1];
    assert.ok(!list.includes("/api"), "the allowlist does not mention /api");
    // The app shell and its built assets are the only things that may be stored.
    for (const needed of ['"/index.html"', '"/manifest.webmanifest"']) {
        assert.ok(sw.includes(needed), `the allowlist must include ${needed}`);
    }
    for (const prefix of ['"/dist/"', '"/icons/"']) {
        assert.ok(list.includes(prefix), `the allowlist must include ${prefix}`);
    }
    // Nothing user-specific is named, and no account screen is in the list.
    for (const never of ["tasks", "settings", "finance", "sessions", "later", "pages", "reports", "share"]) {
        assert.ok(!list.includes(`/${never}`), `${never} must never be cached`);
    }
});

test("the service worker only handles same-origin GETs", () => {
    const sw = read("app/sw.js");
    assert.match(sw, /method !== "GET"/, "only GET is intercepted");
    assert.match(sw, /origin !== location\.origin/, "only same-origin is intercepted");
});

test("the service worker cache is versioned, so an old release is evicted", () => {
    const sw = read("app/sw.js");
    assert.match(sw, /const CACHE = "task-timer-v[\d.]+"/,
        "the cache name carries the app version");
    assert.match(sw, /filter\(k => k !== CACHE\)/,
        "activation deletes every cache that is not the current one");
    const version = /const CACHE = "task-timer-v([\d.]+)"/.exec(sw)[1];
    const pkg = JSON.parse(read("package.json"));
    const appVersion = /APP_VERSION = "([^"]+)"/.exec(read("app/js/config.js"))[1];
    assert.equal(version, appVersion,
        "the service worker cache version and APP_VERSION must be bumped together");
    assert.equal(appVersion, pkg.version,
        "APP_VERSION and package.json must agree");
});

// ------------------------------------------------------- 4. client-side storage

test("IndexedDB holds no authentication state", () => {
    // The session is an HttpOnly cookie: it cannot be read by this script, and
    // the master key is a non-extractable CryptoKey that only exists in memory.
    // So there must be no key in the data layer that names a token, a session or
    // a password.
    const names = [...code(read("app/js/services/crypto-service.js"))
        .matchAll(/^const\s+(\w+)\s*=/gm)].map(m => m[1]);
    for (const name of names) {
        assert.ok(
            !/session|token|password/i.test(name) || /encrypted.key|owner.verifier|kek.salt/i.test(name),
            `crypto-service declares "${name}", which must not be an authentication credential`
        );
    }
    // The only things persisted are the password-wrapped key, the owner-code
    // verifier, and the salt — all of which are useless without the password.
    const persisted = [...code(read("app/js/services/crypto-service.js"))
        .matchAll(/metaRepo\(r\.meta\)\.(?:set|get|delete)\(([A-Z_0-9]+)/g)].map(m => m[1]);
    assert.deepEqual(
        [...new Set(persisted)].sort(),
        ["ENCRYPTED_KEY_NAME", "KEK_SALT_NAME", "OWNER_VERIFIER_NAME"],
        "exactly three values are written to the meta store, all password-protected"
    );
});

test("the session cookie is never read or written by JavaScript", () => {
    for (const file of allJs) {
        const src = code(read(file));
        assert.ok(!/document\.cookie/.test(src),
            `${file} must not touch document.cookie — the session cookie is HttpOnly by design`);
        // And the cookie NAME must not appear in the client, because a client that
        // knows the name is a client that expects to read it.
        assert.ok(!/tt_session/.test(src),
            `${file} must not reference the session cookie name`);
    }
});

test("localStorage is not used at all", () => {
    for (const file of allJs) {
        assert.ok(!/localStorage/.test(read(file)),
            `${file} must not use localStorage — IndexedDB is the only store`);
    }
});

test("an exported file is fully encrypted and carries no plaintext secret", () => {
    const backup = read("app/js/services/backup-service.js");
    // The payload is {app, v, d, ek, owner}: a ciphertext, the password-wrapped
    // key, and the owner-code verifier. The settings and records live inside `d`.
    const payload = /const payload = \{([\s\S]*?)\n\s*\};/.exec(backup);
    assert.ok(payload, "the backup payload literal is findable");
    for (const forbidden of ["password:", "secret:", "rawData", "settings:", "records:", "code:"]) {
        assert.ok(!payload[1].includes(forbidden),
            `the backup payload must not carry "${forbidden}" outside the ciphertext`);
    }
    assert.match(payload[1], /d:\s*encrypted/, "the record set is the ciphertext");
    // And the import path treats the file as untrusted input.
    assert.match(backup, /MAX_IMPORT_BYTES/,
        "an oversized import is refused before it is parsed");
    assert.match(backup, /assertImportShape/,
        "a decrypted payload is shape-asserted before anything is written");
    // An import writes through the registry and re-queues for sync; it never
    // adopts a value from the file as a configuration or a credential.
    assert.ok(!/localStorage|sessionStorage/.test(backup),
        "an import writes to IndexedDB only");
});

test("every API call goes to the same origin with the JSON content type", () => {
    // The API base is a module constant, so an absolute URL anywhere in the
    // client would be a deliberate second destination. None is allowed.
    const sync = read("app/js/services/sync-service.js");
    const base = /const API_BASE = "([^"]*)";/.exec(sync);
    assert.ok(base, "the sync service declares its API base");
    assert.ok(base[1].startsWith("/"), `API_BASE is a same-origin path, got "${base[1]}"`);

    for (const file of allJs) {
        const src = code(read(file));
        if (!/\bfetch\s*\(/.test(src)) continue;
        // No absolute URL, and no protocol-relative one either.
        assert.ok(!/fetch\(\s*["'`]https?:\/\//i.test(src),
            `${file} must not fetch an absolute URL`);
        assert.ok(!/fetch\(\s*["'`]\/\//.test(src),
            `${file} must not fetch a protocol-relative URL`);
        // The content type the server requires — but only where there is a body
        // to type. A GET carries nothing, and the one non-JSON fetches in the
        // client are the share intake's: it READS parked bytes the browser's own
        // share sheet uploaded, and it forgets them with a DELETE. Neither sends
        // anything, so neither can be the CSRF vector the content type exists to
        // close — and requiring a JSON header on a bodyless GET would only teach
        // the next reader to copy a rule that does not apply.
        if (/method:\s*["'](?:POST|PUT|PATCH)["']/.test(src) || /\bbody\s*:/.test(src)) {
            assert.match(src, /"Content-Type":\s*"application\/json"/,
                `${file} sends a body, so it must send the JSON content type the API requires`);
        }
    }
});

// ------------------------------------------------------- 5. transport

test("every API call goes to the same origin with the JSON content type", () => {
    // The API base is a module constant, so an absolute URL anywhere in the
    // client would be a deliberate second destination. None is allowed.
    const sync = read("app/js/services/sync-service.js");
    const base = /const API_BASE = "([^"]*)";/.exec(sync);
    assert.ok(base, "the sync service declares its API base");
    assert.ok(base[1].startsWith("/"), `API_BASE is a same-origin path, got "${base[1]}"`);

    for (const file of allJs) {
        const src = code(read(file));
        if (!/\bfetch\s*\(/.test(src)) continue;
        // No absolute URL, and no protocol-relative one either.
        assert.ok(!/fetch\(\s*["'`]https?:\/\//i.test(src),
            `${file} must not fetch an absolute URL`);
        assert.ok(!/fetch\(\s*["'`]\/\//.test(src),
            `${file} must not fetch a protocol-relative URL`);
        // The content type the server requires — but only where there is a body
        // to type. A GET carries nothing, and the one non-JSON fetches in the
        // client are the share intake's: it READS parked bytes the browser's own
        // share sheet uploaded, and it forgets them with a DELETE. Neither sends
        // anything, so neither can be the CSRF vector the content type exists to
        // close — and requiring a JSON header on a bodyless GET would only teach
        // the next reader to copy a rule that does not apply.
        if (/method:\s*["'](?:POST|PUT|PATCH)["']/.test(src) || /\bbody\s*:/.test(src)) {
            assert.match(src, /"Content-Type":\s*"application\/json"/,
                `${file} sends a body, so it must send the JSON content type the API requires`);
        }
    }
});

test("no client module configures CORS", () => {
    // CORS is a server-side decision. If the client ever grew a configurable
    // origin, a same-origin install would have a second way to be talked into
    // sending its session somewhere.
    for (const file of allJs) {
        const src = code(read(file));
        assert.ok(!/ALLOWED_ORIGIN|Access-Control-Allow-Origin/.test(src),
            `${file} must not reference CORS configuration`);
    }
});

test("a session failure is never reported as a success", () => {
    // auth-service's transport keeps the server's error code, because
    // scheduleSessionRotation decides whether the session is alive from what
    // comes back; a swallowed 401 is indistinguishable from a fresh one.
    const auth = read("app/js/services/auth-service.js");
    assert.match(auth, /if \(!res \|\| res\.ok !== true\)/,
        "a failed rotation must return ok:false");
    assert.match(auth, /data\.error\?\.code/,
        "the server's error code must survive to the caller");
    assert.ok(!/catch\s*\{\s*return\s*\{\s*ok:\s*true/.test(code(auth)),
        "no catch may turn a transport failure into ok:true");
});

// ------------------------------------------------------- 6. server hardening, read from source

test("the API requires a JSON content type on every POST", () => {
    const src = code(read("api/index.php"));
    assert.match(src, /tt_error\(415, 'unsupported_media_type'\)/,
        "a non-JSON content type must be refused — this is the CSRF boundary");
    assert.match(src, /HTTP_SEC_FETCH_SITE/,
        "a browser-labelled cross-site request is refused as a second layer");
    assert.match(src, /CONTENT_LENGTH/,
        "the declared length is checked before the body is read");
    // The size ceiling must be enforced before authentication, not inside the
    // body parser, so the bodyless endpoints cannot skip it.
    const ceiling = src.indexOf("request_max_bytes");
    const auth = src.indexOf("tt_require_session");
    assert.ok(ceiling > 0 && auth > 0 && ceiling < auth,
        "the request-size ceiling is applied before the session is resolved");
});

test("the API routes on an exact path", () => {
    const src = code(read("api/index.php"));
    assert.ok(!/str_ends_with\(\$path/.test(src),
        "a suffix match lets any prefix reach a handler");
    assert.match(src, /%\(\?:2f\|5c\)/i,
        "an encoded path separator is refused rather than resolved");
    assert.match(src, /=== '\.\.'/,
        "a traversal segment is refused rather than collapsed");
});

test("the API always sends the security headers", () => {
    const src = code(read("api/index.php"));
    for (const header of [
        "X-Content-Type-Options",
        "X-Frame-Options",
        "Referrer-Policy",
        "Permissions-Policy",
        "Content-Security-Policy",
    ]) {
        assert.ok(src.includes(header), `api/index.php must send ${header}`);
    }
    assert.match(src, /object-src 'none'/, "object-src must be 'none', not the default-src fallback");
    assert.match(src, /frame-ancestors 'none'/, "frame-ancestors must be 'none'");
    assert.match(src, /Strict-Transport-Security/,
        "HSTS must be implemented, gated on HSTS_MAX_AGE");
    assert.ok(!/unsafe-inline|unsafe-eval/.test(src),
        "the CSP must not need unsafe-inline or unsafe-eval");
    // A wildcard is not an origin: reflecting it alongside Allow-Credentials
    // produces a header pair the spec resolves by rejecting the response.
    assert.ok(src.includes("$allowed === '' || $allowed === '*'"),
        "a wildcard ALLOWED_ORIGIN must be treated as not configured");
    assert.ok(src.includes("hash_equals($allowed, $origin)"),
        "an allowlist entry must be compared with hash_equals, not ==");
    assert.ok(!/Access-Control-Allow-Origin:\s*'\s*\*/.test(src),
        "the ACAO header must only ever carry the configured origin");
    assert.ok(!/Access-Control-Allow-Origin: \*/.test(src),
        "and never a literal wildcard");
});

test("the password hash is argon2id where the build has it", () => {
    const config = read("api/config.php");
    assert.match(config, /in_array\('argon2id', password_algos\(\), true\)/,
        "the algorithm must be detected at runtime, not assumed");
    assert.ok(!/PASSWORD_DEFAULT\s*\)/.test(read("api/auth.php")),
        "auth.php must hash through the resolved algorithm, not PASSWORD_DEFAULT");
    assert.match(read("api/auth.php"), /password_needs_rehash/,
        "a legacy hash must be upgraded on the next successful login");
    assert.match(read("api/auth.php"), /tt_decoy_hash\(\)/,
        "an unknown code must still pay the cost of a password verify");
    assert.match(config, /max_password_bytes/,
        "a password length ceiling must exist so the bcrypt fallback cannot truncate silently");
});

test("both rate limits are scoped, and the space and session counts are bounded", () => {
    const src = read("api/auth.php");
    assert.match(src, /'open'/, "auth/open has its own budget");
    assert.match(src, /'create'/, "auth/create has its own budget");
    assert.match(src, /tt_enforce_session_cap/, "live auth sessions per space are capped");
    assert.match(src, /max_spaces/, "the total number of spaces is capped");
    assert.match(src, /REMOTE_ADDR/, "the client IP comes from REMOTE_ADDR");
    assert.ok(!/X_FORWARDED_FOR|X_REAL_IP/i.test(code(src)),
        "a proxy header must never be trusted as the rate-limit identity");
});

test("the PHP runtime is hardened in the image", () => {
    const ini = code(read("docker/php/php.ini"));
    for (const setting of [
        "expose_php = Off",
        "display_errors = Off",
        "log_errors = On",
        "allow_url_include = Off",
        "file_uploads = Off",
        "session.cookie_httponly = 1",
        "session.use_strict_mode = 1",
        "session.cookie_secure = 1",
    ]) {
        assert.ok(ini.includes(setting), `docker/php/php.ini must set ${setting}`);
    }
    // post_max_size must match REQUEST_MAX_BYTES, or the SAPI buffers a body
    // the application has already decided to refuse.
    assert.match(ini, /post_max_size = 1M/,
        "post_max_size must match the app's 1 MiB REQUEST_MAX_BYTES");
});

test("the nginx config repeats the same policy without shadowing it", () => {
    const conf = read("docker/nginx/default.conf");
    // Comments in this file name the very sources the CSP forbids, so the
    // policy assertions read the directives alone.
    const directives = conf.replace(/^\s*#.*$/gm, "");
    for (const header of [
        "X-Content-Type-Options",
        "X-Frame-Options",
        "Referrer-Policy",
        "Permissions-Policy",
        "Content-Security-Policy",
    ]) {
        assert.ok(directives.includes(`add_header ${header}`), `nginx must send ${header}`);
    }
    assert.match(directives, /object-src 'none'/);
    assert.match(directives, /frame-ancestors 'none'/);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(directives), "the nginx CSP needs no unsafe source");
    // HSTS is deliberately off here: the container serves plain HTTP.
    assert.ok(!/add_header Strict-Transport-Security/.test(directives),
        "HSTS must not be sent by a container that listens on plain HTTP");
    // A single add_header inside a location would replace the whole inherited set.
    const apiBlock = /location \^~ \/api\/ \{([\s\S]*?)\n    \}/.exec(directives)[1];
    assert.ok(!/add_header/.test(apiBlock),
        "the /api/ location must not add_header, which would drop the inherited set");
    // Nothing under /api/ may ever be served as a file.
    assert.match(directives, /fastcgi_param SCRIPT_FILENAME \/app\/api\/index\.php/,
        "every /api/ request goes to the one front controller");
    for (const ext of ["sqlite", "db", "log", "env", "ini", "php"]) {
        assert.ok(directives.includes(ext), `nginx must refuse .${ext} files`);
    }
});

test("the container runs as a non-root user with no capabilities", () => {
    const dockerfile = read("Dockerfile");
    assert.match(dockerfile, /^USER tt$/m, "the php stage must drop to an unprivileged user");
    assert.ok(dockerfile.includes("nginx-unprivileged"),
        "the web stage must use the unprivileged nginx image");
    const compose = read("docker-compose.yml");
    assert.match(compose, /cap_drop:\s*\[ALL\]/, "no capabilities");
    assert.match(compose, /no-new-privileges:true/, "no privilege escalation");
    assert.match(compose, /read_only:\s*true/, "a read-only root filesystem");
    assert.ok(!/^\s*-\s*"?\.\/api\/var/m.test(compose),
        "the database must live in a named volume, not a host bind mount");
});

test("the docker build context excludes what must not be shipped", () => {
    const ignore = read(".dockerignore");
    for (const must of ["api/var", ".git"]) {
        assert.ok(ignore.includes(must), `.dockerignore must exclude ${must}`);
    }
});
