# Security Review — Tadkhir

> This is the **technical review record**, kept for reference. For how to report
> a vulnerability, see [`SECURITY.md`](SECURITY.md).
>
> It was written before the project's first public release, when it was still
> named Task Timer. It is kept as-is so its findings and commit references stay
> accurate; only the title has been updated.

A full review of the Private Sync API, the PWA client, the service worker, the
Docker deployment and the HTTP layer, followed by the fixes for everything the
review found.

This is a record of what was examined, what was found, what was changed, and
what is still not proven. It is not a claim that the system is unbreakable —
that is not a claim anyone can make honestly. What it can claim is which
properties are enforced, where, and by which test.

- **Date of review:** 2026-09-27
- **Commit reviewed:** `cbcdf0f` (v1.2.0)
- **Method:** every endpoint and every data flow was read, then attacked with raw
  HTTP requests against a running server, then in a real browser, then in the
  real container. Findings were reproduced before being fixed and re-attacked
  after.

---

## 1. Executive summary

The core design was sound and is now the strongest part of the system. Data is
end-to-end encrypted; the server holds ciphertext it cannot read. **The protocol
carries no owner identifier at all** — every handler derives the space from the
session cookie, so there is no `spaceId` to swap, no IDOR surface, and no
cross-space access path. That property was already true before this review and
was verified adversarially rather than assumed.

The defects were all in the *edges* of that design: how a request is recognised
before it reaches a handler, what a request is allowed to contain, what the
server does with unbounded input, and what a deployment serves. Nothing in the
encryption model, the sync model or the data model needed to change.

| | Before | After |
|---|---|---|
| Confirmed vulnerabilities (High) | 5 | 0 |
| Confirmed vulnerabilities (Medium) | 9 | 0 |
| Confirmed vulnerabilities (Low) | 6 | 0 |
| API tests | 44 | **99** (44 + 55 security) |
| Client tests | 294 | **327** (294 + 33 security) |
| Attack probes | — | **116** (all previously-exploitable attacks re-run and blocked) |
| Container checks | — | **126** |
| `npm audit` | 0 vulnerabilities | 0 vulnerabilities |

The single most important finding: **the API accepted any `Content-Type`**, which
made login-CSRF possible against the two endpoints that need no cookie. A
cross-origin page could force a victim's browser to open a space of the
attacker's choosing, and from then on the victim's records would sync into it.
That is data exfiltration, and it required no special position — only a web page
and a click. It is fixed by requiring `application/json`, which makes every such
request a preflighted one.

---

## 2. Architecture and trust boundaries

```
Browser
  │  cookie: tt_session (HttpOnly, SameSite=Lax, Secure in prod)
  │  NO secret in JS. Master key = non-extractable CryptoKey, memory only.
  ▼
Service Worker  ── network-first; caches an ALLOWLIST (shell + /dist + /icons).
  │                /api/ is never cached. This is the only client-side trust boundary.
  ▼
Frontend (PWA)
  │  records encrypted with AES-256-GCM before they leave the device
  ▼
Authentication
  │  POST /api/auth/{create,open}  — Argon2id, decoy-hash timing equalisation
  ▼
API (api/index.php)
  │  exact-path routing · Content-Type + size + Sec-Fetch-Site enforced HERE
  │  security headers on every response, error or not
  ▼
Authorization
  │  tt_require_session() — the ONLY source of the space id.
  │  No handler reads an owner reference from the request.
  ▼
SQLite
     records UNIQUE (space_id, store, id) · sessions keyed by sha256(token)
  ▼
Sync / Records
     push: allowlisted types, LWW on updatedAt, per-store quotas, per-space caps
     pull: `rev > cursor`, tombstones included, bounded by PULL_BATCH
```

**Trust boundaries, in the order a request crosses them:**

1. **Network → Service Worker.** Mitigated: same-origin GET only, and an
   allowlist of what may be persisted.
2. **Service Worker → Frontend.** The SW is same-origin code and shares the
   origin's privileges. There is no boundary here — which is exactly why it must
   not be able to *store* anything sensitive.
3. **Browser → API.** Mitigated: HttpOnly cookie (unreadable by JS),
   `SameSite=Lax`, `application/json` required, `Sec-Fetch-Site` checked, size
   ceiling applied before authentication.
4. **API → SQLite.** Mitigated: prepared statements everywhere; no SQL fragment
   is ever built from input; the space id is never a bound value from a request.
5. **Device → Space (peer trust).** *Not* a boundary. Every device in a space
   holds the master key, so a device can write arbitrary records into the space.
   End-to-end encryption prevents the *server* from reading or forging; it does
   not make the members of a space mutually untrusting. See §11.

---

## 3. Findings

Severity is tied to demonstrated impact, not to how a scanner would label it.
Every "Attack scenario" below was executed against the running system.

### HIGH

---

#### H-1 — Login CSRF: any origin could force a session, exfiltrating the victim's data

- **Location:** `api/index.php` → `tt_body()`
- **Problem:** the body parser read `php://input` and called `json_decode` on it
  **regardless of `Content-Type`**. `text/plain` is a CORS-safelisted content
  type, so a cross-origin page can POST it from a plain
  `<form enctype="text/plain">` with **no preflight**. `auth/create` and
  `auth/open` need no cookie, so nothing else gated them. The browser stores the
  `Set-Cookie` the response sends back.
- **Attack scenario:**
  1. Attacker hosts a page and serves a form that auto-submits
     `POST /api/auth/open` with `{"code":"attacker-space","password":"…","device":{"id":"d"}}`
     as `text/plain`.
  2. Victim visits the page. No preflight, no warning.
  3. The victim's browser stores a session cookie for the **attacker's** space.
  4. The victim's app then syncs normally — pushing their task titles, session
     history, finance records and debts into a space the attacker owns, and can
     decrypt.
- **Impact:** silent, complete data exfiltration of every record the victim
  creates. No user interaction beyond visiting a page. Modern third-party-cookie
  blocking mitigates this in *some* browsers; it is not universal, and it is not
  something a server should be relying on.
- **Fix:** `tt_body()` now requires `Content-Type: application/json`
  (`415` otherwise). `application/json` is not CORS-safelisted, so every such
  request becomes a preflighted one, which the server refuses for any origin
  outside a configured allowlist. `Sec-Fetch-Site: cross-site` is additionally
  refused with `403` — a second, free layer that does not depend on the browser
  honouring the content type.
- **Verification:** `api/tests/security.php` → *csrf: a form-simple content type
  cannot reach the auth endpoints*; *csrf: a browser-labelled cross-site request
  is refused*. Confirmed before the fix: `POST /api/auth/create` as `text/plain`
  returned `200` and issued a cookie. After: `415`, no `Set-Cookie`.
  `Content-Type: application/json; charset=utf-8` still works.

---

#### H-2 — Space enumeration through a timing side channel

- **Location:** `api/auth.php` → `task_timer_auth_open()`
- **Problem:** `password_verify()` was reached **only when the space code
  existed**. The code's own comment claimed "Same 401 for unknown code and wrong
  password: no enumeration" — true of the response, false of the *timing*.
- **Attack scenario:** measure. Measured before the fix:
  **unknown code 19.4 ms, wrong password 130.1 ms — a 6.8× gap.** An attacker
  walks the entire code space, one request per candidate, at 8 requests/second,
  and gets a perfect oracle for which spaces exist. Every hit is then a known
  target for password guessing.
- **Impact:** defeats the obscurity the space code is the only barrier behind
  for a user who chose their own code; converts a rate-limited brute force into
  an unlimited enumeration.
- **Fix:** `tt_decoy_hash()` — a real hash of the resolved algorithm, generated
  once per process from an unguessable value. When the code does not exist,
  `password_verify()` runs against the decoy, so both paths do the same work.
- **Verification:** `api/tests/security.php` → *auth: an unknown code and a
  wrong password cost the same time*, which fails if the ratio exceeds 1.6.
  Measured after: **unknown code 15.9 ms, wrong password 13.1 ms (ratio 0.83)**.

---

#### H-3 — Unauthenticated CPU exhaustion via `auth/create`

- **Location:** `api/auth.php` → `task_timer_auth_create()`
- **Problem:** `auth/create` computes a full password hash on **every** call and
  is unauthenticated, and it was metered by **nothing at all** — the only rate
  limiter was keyed on *failed* `auth/open` attempts, which a script calling
  `create` never trips.
- **Attack scenario:** `while(true) post('/api/auth/create', {...})`. Measured
  before the fix: **268.7 ms per request against 15.6 ms for a trivial endpoint
  — 17.2× amplification, entirely unauthenticated.** With `pm.max_children = 8`
  every worker is saturated by ~50 concurrent connections, and the health check
  (which needs a worker) starts failing. Each request also added a permanent row
  to `spaces`; there was no cap on the table.
- **Impact:** denial of service from the internet, plus unbounded disk growth.
- **Fix:** a second, independent rate-limit budget (`create`) metered by
  **attempts**, charged immediately before the hash so it bounds the expensive
  step and nothing else. `MAX_SPACES` (default 10,000) refuses further creates
  with `503`. `auth_failures` gained a `scope` column so the two budgets cannot
  be spent against each other.
- **Verification:** `api/tests/security.php` → *auth: auth/create is rate limited
  by attempts*; *auth: the instance refuses to create spaces past MAX_SPACES*;
  *auth: the create budget and the open budget do not share a counter*.

---

#### H-4 — Password truncation: anything past byte 72 was ignored

- **Location:** `api/auth.php` → `task_timer_auth_create()`
- **Problem:** `PASSWORD_DEFAULT` is **bcrypt** (`$2y$`) on this build, and
  bcrypt silently ignores input past 72 bytes. There was no maximum password
  length, so a 200-character password was accepted — and any other
  200-character password sharing its first 72 bytes authenticated against it.
- **Attack scenario:** reproduced directly. Create a space with
  `password = "A"×100`. Then `POST /api/auth/open` with
  `"A"×100 + "DIFFERENT-TAIL"` → **`200 OK`**, a full session. The submitted
  password is not the stored password; only its first 72 bytes match.
- **Impact:** users who believe a 100-character passphrase is being protected are
  protected by 72 bytes of it. Combined with H-2 (free enumeration) this is the
  most direct route to a full account.
- **Fix:** `task_timer_password_algo()` resolves the algorithm **at runtime from
  `password_algos()`** and prefers Argon2id, which is memory-hard and has no
  input limit. Argon2id is not *assumed* — asking for it on a build without
  libargon2 is a fatal error, not a fallback. `password_needs_rehash()` upgrades
  a legacy bcrypt hash to Argon2id on that account's next successful login, so
  no user is forced to re-create anything. A `max_password_bytes` ceiling
  (1024) makes the bcrypt fallback behave the same way rather than truncating.
- **Verification:** `api/tests/security.php` → *auth: a password is never
  truncated*, *auth: passwords are hashed with argon2id*,
  *auth: a legacy bcrypt account still opens and is upgraded on login*.
  Confirmed in the **running container**: the stored value is
  `$argon2id$v=19$m=65536,t=4,p=1$…`, `password_verify` accepts the right
  password and rejects the wrong one, and the plaintext does not appear anywhere
  in the database file.

---

#### H-5 — No security headers at all in the documented single-container deployment

- **Location:** `docker-router.php`
- **Problem:** the header policy existed in `docker/nginx/default.conf` and in
  `app/_headers`, but **not** in `docker-router.php` — which is what
  `npm run dev` runs and what the README recommends for a single-container
  install. Measured on that path before the fix:

  ```
  X-Powered-By: PHP/8.4.20
  Content-Type: application/json; charset=utf-8
  Cache-Control: no-store
  X-Content-Type-Options: nosniff
  ```

  No CSP. No `frame-ancestors`. No `Referrer-Policy`. No `Permissions-Policy`.
  Plus the exact PHP version on every response.
- **Attack scenario:** not one bug but the absence of every layer: the app was
  framable, referrer-leaking, and advertising its interpreter version. Because
  `index.html` carries a `<meta>` CSP, the *shell* was partly covered — but the
  API responses were not, and `<meta>` cannot set `frame-ancestors`.
- **Fix:** one `tt_security_headers()` function applied to every response the
  front controller produces, and an equivalent one in the router. `X-Powered-By`
  is removed with `header_remove()` — measured: `ini_set('expose_php','0')`
  alone does **not** remove it on the built-in server, `header_remove()` does.
  nginx had the same latent bug in its CSP: `object-src` fell back to
  `default-src 'self'`, which still permits same-origin plugin content. It is
  now `'none'`, matching what `_headers` and the `<meta>` already said.
- **Verification:** `api/tests/security.php` → *headers: every response carries
  the security headers*, asserted on **7 different responses including the 401,
  the 400 and the 404**; *headers: HSTS is absent by default*. Also confirmed
  against the running container (nginx path) and the built-in server path:
  140/140 and 126/126 checks.

---

### MEDIUM

---

#### M-1 — The request-size ceiling was skipped on three endpoints

- **Location:** `api/index.php` → routing
- **Problem:** the ceiling lived inside the body parser, and `auth/status`,
  `auth/logout` and `auth/rotate` **never called the parser** — they ignore the
  body. Measured with `REQUEST_MAX_BYTES=2048`: a **200,000-byte body was
  accepted** on all three. The parser also read the body into memory *before*
  comparing sizes.
- **Impact:** a large body was allocated and discarded. Bounded by
  `post_max_size`, but that default was **8 MiB** while the app's own limit was
  1 MiB — so the SAPI buffered 8× the intended ceiling before the application
  was ever consulted. Fixed at three levels: the declared `Content-Length` is
  checked before anything else runs; `post_max_size` is pinned to the same 1 MiB
  in `docker/php/php.ini`; nginx's `client_max_body_size` already matched.
- **Fix:** one check, first, for every POST, before routing and before
  authentication.
- **Verification:** *input: the request size ceiling applies to every POST* —
  `413` on all five endpoints.

---

#### M-2 — Type coercion turned `"Array"` into a space code

- **Location:** `api/auth.php` → `tt_read_auth_body()`
- **Problem:** `(string)['a']` is `"Array"` in PHP, and `"Array"` passes the
  space-code regex. Wrong-typed fields were **cast, not refused**.
- **Attack scenario:** `{"code":["a"],"password":"…","device":{"id":"d"}}` →
  **`200 OK`, a space created whose code was literally the word `Array`.**
  Confirmed, along with `code: 12345` → space `12345`, `code: true` → space
  `true`, and `device.id: ["a"]` → device `Array`. Every such caller collided on
  the single row that name maps to — a one-request denial of service against any
  space code an attacker could guess someone else had used.
- **Fix:** every field is checked for type first; a wrong type is `400`, never
  cast. A JSON array at the top level is refused too (`[1,2,3]` decoded to an
  array, and every field lookup on it silently fell through to its default).
- **Verification:** *input: a non-string field is refused, not cast* — 12 cases,
  and a well-formed body with extra unknown fields is still accepted (refusing
  unknown keys would break every future client that adds a field).

---

#### M-3 — Unbounded `device.label`, stored server-side

- **Location:** `api/auth.php` → `tt_read_auth_body()`
- **Problem:** `device.id` was length-checked; `device.label` was **not checked
  at all** and was stored verbatim.
- **Attack scenario:** a request with a 1-byte `device.id` and a **2,000,000-byte
  label** returned `200`, and the row in SQLite measured `length(label) =
  2000000`. Storage amplification from a tiny request, on a table with no other
  bound.
- **Fix:** a `max_device_label_len` ceiling (default 120) — a device label is a
  display name, and 120 characters is generous for one.
- **Verification:** *session: an over-long device label is refused instead of
  stored*.

---

#### M-4 — Unbounded live sessions per space

- **Location:** `api/auth.php` → `tt_start_session()`
- **Problem:** every successful login inserted a session row; nothing removed
  one except that caller's own logout or a 24h expiry. The device cap did not
  help, because **one device may log in repeatedly**.
- **Attack scenario:** measured — **30 logins from a single device id produced
  31 live sessions.** Each live row is a cookie granting full access to the
  space, so this bounds both storage and the number of credentials in
  circulation.
- **Fix:** `tt_enforce_session_cap()` trims the space's oldest sessions to
  `MAX_AUTH_SESSIONS_PER_SPACE` (default 32) before each insert. The first
  implementation had an off-by-one — trimming *to* the cap and then inserting
  left `cap + 1` (measured 9 against a cap of 8) — and the test caught it.
- **Verification:** *session: a space cannot hold an unbounded number of live
  sessions* — 31 logins, cap of 5.

---

#### M-5 — Any member of a space could rename another member's device

- **Location:** `api/auth.php` → `tt_register_device()`
- **Problem:** a device id is chosen by the client and carries no proof of
  possession, so any member can claim any id. Logging in with an existing id
  **overwrote its label**.
- **Attack scenario:** reproduced — device `victim-01` was labelled
  `My Phone`; a second device logged in claiming id `victim-01` with label
  `RENAMED-BY-OTHER-DEVICE`, and the label changed.
- **Fix:** the first registration of an id keeps its label; a later login only
  refreshes `last_seen_at`. This is a display name, not a security boundary, and
  the comment says so — the point is that it should not be *writable by others*.
- **Verification:** *session: one member of a space cannot rename another member
  device*.

---

#### M-6 — CORS: `Access-Control-Allow-Origin: *` with `Allow-Credentials: true`

- **Location:** `api/index.php` → `tt_cors_origin()`
- **Problem:** `ALLOWED_ORIGIN='*'` was treated as a valid origin and reflected
  verbatim, **together with** `Access-Control-Allow-Credentials: true`. The spec
  resolves that contradiction by rejecting the response, so the setting only ever
  *looked* like it permitted cross-origin credentialed reads.
- **Fix:** a wildcard is treated as "not configured" — same-origin only, which
  is what an unset value already means. A configured origin is compared with
  `hash_equals`, never `===`. `tt_cors_headers()` is the only place that emits
  ACAO, and it can only ever carry the configured origin.
- **Verification:** *cors: a wildcard ALLOWED_ORIGIN does not reflect a
  wildcard*; *cors: a configured origin is matched exactly* — including
  `https://good.example.evil.com` and `HTTPS://good.example`, both refused. The
  allowlist was already strict; that is now pinned by a test.

---

#### M-7 — Suffix routing let any prefix reach any handler

- **Location:** `api/index.php` → routing
- **Problem:** routes matched with `str_ends_with($path, '/auth/open')`, so
  **any** prefix reached the handler. Confirmed for `/whatever/auth/status`,
  `/index.html/auth/status`, `/api/../api/auth/status` and `/x/y/z/auth/open`.
  The health check was worse — it matched the raw `REQUEST_URI`, so
  `/anything/health`, `/health` and `/etc/health` all returned health.
- **Impact:** a path-based allowlist in a reverse proxy in front of the app
  (`location /api/ { … }`) is bypassable through any prefix at all, and the
  mismatch between what the proxy sees and what the app executes is the whole
  class of parsing-disagreement bugs.
- **Fix:** an **exact** map from path to handler, applied to a normalized path.
  A `..` segment is **refused, not collapsed** — no legitimate request to this
  API contains one, and refusing removes the possibility of the two parsers
  disagreeing instead of relying on them to agree. An encoded separator (`%2f`,
  `%5c`) is refused before decoding, for the same reason. Percent-decoding
  happens once, in one place, before routing.
- **Verification:** *routing: a handler is reachable only at its exact path* (9
  cases) and *routing: health is not reachable at an arbitrary path suffix*.
  Trailing slashes and empty segments still normalize to the same handler, which
  is a normalization every server does, and that is pinned too.

---

#### M-8 — The service worker would have cached any future API response

- **Location:** `app/sw.js`
- **Problem:** the worker cached every same-origin `GET` with `status === 200`,
  with no `Cache-Control` check and no path rule. A Cache Storage entry outlives
  the response, is never evicted except by a new release, and is readable by
  every script on the origin. Today the only `GET` under `/api/` is `/api/health`,
  so **nothing sensitive was actually being stored** — this is a landmine, not a
  live breach.
- **Fix:** a **positive allowlist** of the offline app: `/`, `/index.html`,
  `/manifest.webmanifest`, `/dist/`, `/icons/`. `/api/` is refused twice — by
  the allowlist and by an explicit guard, because that is the one path where
  per-session data lives. An allowlist stays true as the app grows; a deny-list
  has to be right about every request the app will ever make.
  - *Note:* the first attempt also refused anything the server marked
    `Cache-Control: no-store`. That is **wrong here and broke offline mode** —
    the app's shell is deliberately `no-store` to defeat the *browser's* HTTP
    cache, one layer below the worker, and that cache is what makes a rebuilt
    bundle get picked up. The two caches have different jobs. Found by testing in
    a real browser (Cache Storage came back empty), not by reading the code.
- **Verification:** `tests/security.test.mjs` → *the service worker caches an
  allowlist, and the API is not on it*. End-to-end in a real browser: a full
  `auth/create` → `sync/push` → `sync/pull` → `auth/status` cycle plus two
  `/api/health` requests left Cache Storage containing exactly
  `["/", "/dist/styles.css", "/dist/bundle.js"]` and nothing else, while the
  offline app (shell 1,582 bytes, bundle 244,760 bytes, stylesheet 82,835 bytes)
  remained complete and usable.
- **Re-measured 2026-09-28**, after the build moved the assets to hashed names:
  Cache Storage holds `["/", "/dist/app.fc4c4cb7.css", "/dist/app.e12b8822.js"]`
  — 1,262 / 31,777 / 263,253 bytes — still nothing from `/api/`. Repeating the
  offline half of that test found a second bug, below the allowlist: the shell is
  filed under the pathname the online navigation used, which is `/`, while the
  fallback looked only for `/index.html`. With the server stopped and the cache
  warm, `caches.match("/index.html")` resolved to **nothing** — and a miss here
  is silent, because `respondWith(undefined)` renders an empty document with no
  error logged. The app therefore booted from `/` while online and showed a blank
  page at the same address while offline, and a deep link such as `/settings`
  was not answered by the worker at all: the allowlist gates by path, and no app
  path is on it. The worker now answers **every** navigation and looks the shell
  up under the request's own path, then `/index.html`, then `/`; what may be
  *stored* is still the allowlist, unchanged, so no app route is now filed in
  Cache Storage. Pinned by `tests/build.test.mjs` → *an offline navigation finds
  the shell under every key it can be stored at*.

---

#### M-9 — Data arriving over sync was written to IndexedDB unvalidated

- **Location:** `app/js/services/sync-service.js` → `applyChanges()`
- **Problem:** the **import** path runs `assertImportShape()` on every
  decrypted record, but the **sync** path wrote incoming records straight into
  the data layer with no validation. A `later` record could therefore arrive with
  `url: "javascript:…"` and reach an `href` without ever passing
  `validateLaterUrl()`.
- **Exploitability:** low, and honestly stated — records are AES-GCM encrypted
  with the master key, so forging one requires an existing device of the same
  space (or the server itself). The server **cannot** inject.
- **Fix:** the concrete sink is closed where every external link is emitted.
  `action()` in `app/js/ui/components/ui.js` now runs an `external` href through
  the same `safeHref()` policy the rich-text renderer already used (http, https,
  mailto; no control characters), so the two places a user-supplied URL becomes
  link agree by construction. A refused URL renders a disabled control rather
  than a dead link.
- **Verification:** `tests/security.test.mjs` → *an external link is checked
  against the link policy before it is emitted*, plus 13 `safeHref` cases
  including `javascript:`, `data:`, `vbscript:`, `blob:`, `file:`, and a
  newline-smuggled `java\nscript:`. Confirmed in a real browser: five `later`
  records written **directly into IndexedDB** (bypassing all validation, exactly
  as `applyChanges` would) produced **no anchor at all** for the `javascript:`,
  `data:` and control-character URLs, while both legitimate `https://` links
  still rendered, and the `onerror` payload in a title rendered as literal text.

---

### LOW

---

#### L-1 — `sync.sqlite` was world-readable inside the container

`api/db.php` asked for `mkdir($dir, 0700)`, but that only runs when it *creates*
the directory — and the Dockerfile and the named volume both create
`/app/api/var` first, so the intent was never realised. SQLite created the file
`0644`. Measured in the running container before the fix:
`drwxr-xr-x` / `-rw-r--r--`. Now `drwx------` / `-rw-------`: the Dockerfile
`chmod 700`s the directory, and `db.php` `chmod 0600`s the file on every open
(best-effort, so an exotic mount is never fatal). Narrow in practice — the
container is the real boundary — but it makes the code do what it already said.
Pinned by `tests/db-permissions.test.mjs`.

#### L-2 — Dead code fabricated a session expiry

`tt_auth_payload()` computed `expiresAt` as `now + session_lifetime` rather than
the session's real expiry, so a client painting a countdown from it would keep
showing a live session after the server had expired it. The function was never
called; removed.

#### L-3 — Two `Set-Cookie` headers on rotation

`auth/rotate` deleted the cookie and then immediately set a new one of the same
name. Browsers apply the last, but any client reading the first — including this
suite's own helper — concludes the rotation issued nothing. The redundant clear
was removed.

#### L-4 — A race on `spaces.code` returned 500 instead of 409

The `SELECT`/`INSERT` pair is racy; the `UNIQUE` constraint is the real arbiter
and its violation reached the global exception handler as a `500`. Now caught and
answered `409 space_exists`, the same answer the losing `SELECT` would give.

#### L-5 — `POST post_max_size` defaulted to 8 MiB against a 1 MiB app limit

See M-1. `post_max_size = 1M`, `upload_max_filesize = 1M`, `file_uploads = Off`.

#### L-6 — `.webmanifest` was served as `application/octet-stream` in the container

The base nginx image has no MIME entry for `.webmanifest`, and the browser's
install criteria **reject** a manifest served as `octet-stream` — so the
container deployment could not install as a PWA and the share target never
registered, while the same app worked everywhere else. Fixed with a `types` block
that re-includes `mime.types` (a `types` block *replaces* the inherited map, so
omitting the include would break the CSS and JavaScript types). Verified in the
running container: `application/manifest+json`, and the built assets still
correct — `app.e12b8822.js` as `application/javascript`, `app.fc4c4cb7.css` as
`text/css`, neither served as anything else.

---

## 4. Verified secure — no change needed

These were attacked and found sound. Stating them matters as much as the fixes.

| Property | How it was tested | Result |
|---|---|---|
| **Cross-space isolation** | Two spaces, forged `spaceId`/`space_id`/`space`/`ownerSpace` in the body, cross-space read, overwrite and tombstone | The body field is **ignored**; the space comes only from the session. Alpha's record was byte-identical after bravo's read, write and delete attempts. |
| **No owner identifier in the protocol** | Read every handler | No endpoint accepts a space, owner or device *credential*. There is no IDOR surface to close. |
| **SQL injection** | 10 payloads through `code`, `device.id`, and `record id` (the one field with no allowlist) | All bound. Tables intact, password hash byte-identical, payloads stored verbatim as opaque ids. |
| **Stored / reflected / DOM XSS** | Browser: `<img onerror>`, `<script>`, `<svg onload>`, `javascript:`, `data:`, iframe, in a task title, a note, and a `later` URL written straight into IndexedDB | Zero fired. `imgs: 0`, `scripts: 1` (the app's own bundle). Payloads rendered as literal text. |
| **No HTML sink** | Static scan of all 100+ modules | No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, `srcdoc`, or `on*` attribute anywhere. |
| **Path traversal / file disclosure** | 32 paths × 2 methods, encoded and double-encoded, NUL bytes | `/api/var/sync.sqlite`, the WAL and SHM sidecars, every PHP source, `api/tests/*`, `package.json`, `Dockerfile`, `.gitignore`, `.env`, `_headers` — **none reachable**, and no response ever contained `SQLite format 3` or `<?php`. |
| **Session invalidation** | Rotate, logout, forged token, empty token, truncated token, expired row | The old token dies **immediately** on rotate and on logout. All forgeries `401`. |
| **Cookie flags** | Read `Set-Cookie` in a production environment | `secure; HttpOnly; SameSite=Lax; path=/`. `document.cookie` appears nowhere in the client. |
| **Token storage** | Compared the cookie value against every `token_hash` row | Only a 64-char sha256 digest. The 256-bit token never touches disk. |
| **Password in a URL / log / response** | Grepped sources, responses, container logs, and the database file | Never present. Not in IndexedDB, not in `localStorage`, not in the SW cache, not in a backup, not in the export. |
| **Error responses** | 5 malformed requests, scanned for 14 internal markers | Fixed `{"ok":false,"error":{"code":…}}` shape. No filesystem path, SQL, stack trace, `password_hash`, session token, env var or `PHP/` version. Logs keep the exception class and message, which is what makes them useful. |
| **Rate limiting** | `auth/open` failures, `auth/create` attempts, budget independence | Works; the two budgets are independent (one could previously lock the other out). |
| **LWW, tombstones, quotas, pagination** | Replayed pushes, stale writes, stale deletes, oversized batches, absurd cursors | Idempotent, monotone, quota-enforced, cursor-correct. |
| **Dependencies** | `npm audit`, `npm outdated` | **0 vulnerabilities.** 144 devDependencies, **0 runtime** — nothing third-party ships to the browser. `sass` has a patch bump available. |

---

## 5. Reviewed and found adequate

- **`/api/health`** — public, returns `{"ok":true,"time":…}`. No secret, no
  version, no internal identifier. Now an exact route.
- **`api/gc.php`** — CLI only, argv strictly validated with `ctype_digit`, two
  `finally`-style transactions, read-only with `--dry-run`. Not reachable over
  HTTP (proven above).
- **`api/db.php`** — WAL, `busy_timeout`, `foreign_keys` on, transactions around
  multi-row writes, `UNIQUE(space_id, store, id)`, `AUTOINCREMENT` on `rev` for a
  monotone pull cursor. The v1→v2 migration is transactional with rollback.
- **Docker** — non-root (`USER tt`, uid 10001; `nginx-unprivileged`), `read_only`
  rootfs, `cap_drop: [ALL]`, `no-new-privileges`, tmpfs `/tmp`, named volume for
  the database. Verified: `docker cp` **fails** with *"container rootfs is marked
  read-only"*.
- **IndexedDB storage** — the only three values written to `meta` are the
  password-wrapped key, the owner-code verifier and the salt; all are useless
  without the password. The master key is a non-extractable `CryptoKey`.
  `localStorage` is unused. `sessionStorage` holds only a share payload.
- **Import** — `MAX_IMPORT_BYTES` before parsing, `assertImportShape` before any
  write, per-store quotas re-applied on restore, running sessions normalised to
  `paused`, `activeSlot` stripped (it is device-local and meaningless elsewhere).
- **Backup export** — payload is `{app, v, d, ek, owner}`: a ciphertext, the
  password-wrapped key, and a PBKDF2 verifier. The record set lives inside `d`.

---

## 6. Review method

Every finding above was **reproduced before it was fixed** and **re-attacked
after**. Specifically:

- **3 probe scripts** against live servers, ~150 checks: timing, rate limits,
  CORS, traversal, type coercion, cross-space isolation, session lifecycle, SQL
  and XSS payloads, data exposure.
- **A verification script** re-running every confirmed attack after the fixes:
  **116/116 blocked.**
- **The real container** (`docker compose up`, nginx + php-fpm, production env):
  **126/126 checks**, including that the plaintext password appears nowhere in
  the 57 KB database file and that the stored value is `$argon2id$…`.
- **A real browser**: the app boots with a clean console, the service worker
  takes control, Cache Storage holds exactly the allowlist, the offline app is
  complete, and five XSS payloads written straight into IndexedDB execute
  nothing.
- **Static analysis** of all 100+ client modules and every config file, now
  pinned by tests so a regression fails the build.

A finding that could not be reproduced was not reported as a finding.

---

## 7. Tests added

All of these are permanent and run in CI.

**`api/tests/security.php`** — 55 tests, each against its **own** server with
its **own** port and database, because a group about a rate limit has to be able
to cross that rate limit. Covers: authentication (valid/invalid password, valid/
invalid code, timing, hashing, truncation, legacy-hash upgrade, brute force,
budgets, space cap); authorization (unauthenticated access, cross-space read /
write / delete, forged identifiers, device identity); input (type coercion,
malformed and empty bodies, deep nesting, size ceilings, type allowlist,
timestamps and cursors, over-long ids); injection (10 SQL payloads, 6 XSS
payloads, 32 traversal paths); sync (forged space, LWW, replay, stale cursor,
batch poisoning, envelope, oversized batch, ghost devices); CSRF; CORS; routing;
headers; and error-response disclosure.

> A note for whoever extends this: the first version of this file reused the
> functional suite's port. The second server could not bind, so **every group's
> requests were answered by the previous group's server** — right database,
> wrong limits — and assertions passed or failed for entirely the wrong reason.
> `api/tests/run.php`'s own rate-limit test caught it. A fresh port and a fresh
> file per group is load-bearing, not tidiness.

**`tests/security.test.mjs`** — 30 tests: no HTML sink, the element factory, the
closed tag list, the link policy, secret scanning across sources *and* the built
bundle, the service worker allowlist and cache versioning, no `document.cookie`,
no `localStorage`, encrypted backups, same-origin-only transport, no client-side
CORS, and source-level assertions on the API's content-type enforcement, exact
routing, headers, hashing, rate-limit scoping, `php.ini`, the nginx config and
the container.

**`tests/db-permissions.test.mjs`** — 3 tests for L-1.

```
$ npm test
  api      99 passed, 0 failed   (44 functional + 55 security)
  client  327 passed, 0 failed   (294 existing + 33 security)
```

(The client suite has grown since — 381 with the build guards, 382 with the
offline-shell one. The counts above are this review's own run, left as recorded;
`CHANGELOG.md` carries the current totals.)

---

## 8. Verification status

**Audited** — every PHP file, every client module, every config file, the
Dockerfile, the compose files, the nginx config, the PHP runtime config, the
service worker, the manifest, `package.json`/`package-lock.json`.

**Fixed** — 20 findings (5 High, 9 Medium, 6 Low). Every one has a regression
test.

**Verified** — the attack probes (116), the container (126), the API suite (99),
the client suite (327), `npm audit` (0), `npm run build` (clean), a Docker build
of every stage, a live container stack with its health check, and a real browser
session covering the PWA shell, the service worker, offline mode and XSS.

**Not verified** — stated plainly:

1. **`tests/net.test.mjs` fails in the Docker `test` target on Node 22.** Three
   tests are *cancelled* with `Promise resolution is still pending but the event
   loop has already resolved`. This is **pre-existing**: reproduced on unmodified
   `HEAD` in a clean worktree, same 3 cancellations. Those tests pass on the
   local Node 25. Neither `tests/net.test.mjs` nor `app/js/app/net.js` was
   touched. Left alone as out of scope; it needs a Node-version-aware skip or a
   fix in the test, and the choice is the project's.
2. **Argon2id in the production image.** Verified present in the locally-built
   image and in this container. The algorithm is detected at runtime, so a build
   without libargon2 falls back to bcrypt — safe, with the 72-byte ceiling in
   place, but weaker. Not verified on every architecture.
3. **Real-browser testing was Chromium-family only.** `SameSite`, service-worker
   update semantics and `Sec-Fetch-Site` differ across engines; Firefox and
   Safari were not exercised. The Content-Type requirement does not depend on
   any engine behaviour, which is why it is the primary control.
4. **No third-party cookie environment.** H-1's exploitability is reduced by
   third-party-cookie blocking in some browsers. The fix does not rely on it.
5. **Load and concurrency testing is limited to the probes above.** No
   sustained-rate or many-connection soak was run; the limits are asserted, not
   load-measured.
6. **The `playwright`-class PWA install flow was not driven to completion**;
   the manifest MIME type and the share-target route were checked directly
   instead.
7. **A malicious *device in the same space*** was reasoned about rather than
   built. The encryption model makes the server unable to forge records, and the
   one reachable sink is closed and browser-tested (M-9), but no end-to-end
   hostile-peer test exists.

---

## 9. Residual risk

Ordered by what is most worth attention.

1. **A space's devices trust each other.** Every device holds the master key, so
   any one of them can write arbitrary records into the space — a hostile device
   can corrupt its peers' data. This is inherent to shared-master-key E2EE, not a
   bug, and it is not fixable without per-device keys (a design change, well
   beyond a hardening pass). **Mitigation today:** the one navigation sink is
   allowlisted (M-9), and every rendering path is text-only. The
   `assert*Records` helpers in `app/js/domain/validation.js` are already written
   and used by the import path; wiring them into `applyChanges()` would harden
   this further. That was **deliberately not done here** — a wrong assertion
   would silently drop legitimate records from a space mid-sync, and choosing the
   right per-type invariants is a product decision, not a security one.
2. **A shared IP can lock out legitimate logins.** Rate limiting is per-`REMOTE_ADDR`
   with no per-account dimension, so users behind one NAT share a budget. Raising
   the limits is an env var; adding an account dimension was not attempted.
3. **No idle timeout.** A session is 24h from creation and is not extended, but
   it is also not shortened by inactivity. Rotation every 24h bounds the window.
4. ~~**The nginx `expires 1y` on `/dist/` is inconsistent with the router's
   `no-store`.**~~ **Closed 2026-09-28, by the fix this item asked for.** The
   built assets are now named after the hash of their own content
   (`app.e12b8822.js`, `app.fc4c4cb7.css`), so a URL now means one thing forever:
   a changed byte produces a changed name, and an unchanged name is safe to keep
   for a year. Both servers therefore send `immutable` for a hashed name — the
   year-long policy nginx always had, and the router's `no-store` now reserved
   for the shell, the worker and the manifest, the only responses whose URL does
   *not* change. The consequence named above — a fix that never reaches an
   nginx-deployed client — no longer has a path to happen. Two conditions make it
   stick, and both are asserted: every name is content-derived
   (`tests/build.test.mjs`), and a rebuilt shell references only files that build
   just emitted. The `no-store`-on-`/dist/` comment in `docker-router.php` and the
   deliberate disagreement this item recorded are both gone with it.
5. **HSTS is off by default.** Correct for a container serving plain HTTP, and
   `HSTS_MAX_AGE` is implemented and tested. It must be enabled at the TLS
   terminator; until then the deployment has no transport-downgrade protection.
6. **`ALLOWED_ORIGIN` remains a foot-gun by design.** It is required for a
   cross-origin frontend, and it switches the cookie to `SameSite=None; Secure`,
   which materially weakens the CSRF posture that same-origin deployment gets for
   free. It is documented, and a wildcard is refused, but the same-origin
   recommendation is load-bearing.
7. **The worker's offline answer needs the connection to *fail*, not to fail
   *well*.** The shell fallback runs on a rejected `fetch`, which is what a dead
   origin produces. A reverse proxy or load balancer in front of a restarting
   container answers `502`/`504` instead, and a 502 is a perfectly good response:
   it is passed through, so during a deploy the user sees the gateway's error
   page rather than the cached app. Measured, not assumed — stopping the server
   under the test harness produced exactly that, and the shell was in Cache
   Storage the whole time. Treating a 5xx as a failure was rejected on purpose:
   `docker-router.php` answers `503` with a page that says the app was never
   built, and hiding that behind a cached shell would turn a loud misconfiguration
   into a silent one. The cost is a few seconds of error page on a bad deploy,
   which is the cheaper of the two.

---

## 10. Files changed

| File | Change |
|---|---|
| `api/index.php` | Exact routing; path normalization with `..` and `%2f` refused; `Content-Type: application/json` required (the CSRF fix); `Sec-Fetch-Site` checked; size ceiling before authentication; security headers on every response; `X-Powered-` removed; CORS wildcard refused and `hash_equals`; 405 with `Allow`; `array_is_list` body check |
| `api/auth.php` | Argon2id resolution + `password_needs_rehash`; decoy-hash timing equalisation; type-strict body validation; password/device caps; per-scope rate limits; `MAX_SPACES`; session cap; device label no longer writable by others; race → 409; dead code removed |
| `api/config.php` | `password_algo`, `max_password_bytes`, `rate_max_create`, `max_spaces`, `max_auth_sessions_per_space`, `max_device_label_len`, `hsts_max_age` |
| `api/db.php` | `auth_failures` gained `scope` (with migration); index on `sessions`; `sync.sqlite` chmod 0600 |
| `docker-router.php` | Security headers on every response; `X-Powered-By` removed; path normalization with `realpath` containment; closed content-type list; no executable extensions; explicit `Content-Length`; `sw.js` and HTML never cached |
| `app/sw.js` | Cache allowlist; `/api/` never cached; offline mode preserved and verified |
| `app/js/ui/components/ui.js` | External hrefs pass through `safeHref` |
| `docker/nginx/default.conf` | `object-src 'none'`; `script-src`/`style-src`/`connect-src`/`worker-src`/`manifest-src` explicit; `base-uri 'none'`; `frame-ancestors 'none'`; `.webmanifest` MIME; extension deny list; timeouts; documented HSTS decision |
| `docker/php/php.ini` | `expose_php=Off`; `allow_url_include=Off`; `file_uploads=Off`; `post_max_size=1M`; session cookie hardening; execution limits |
| `Dockerfile` | `/app/api/var` chmod 700 |
| `api/tests/run.php` | `request()` accepts custom headers; requires the security suite; create budget raised for the functional run |
| `api/config.local.php.example` | Documented every security knob |
| `README.md` | New `## الأمان` section: what is protected, what to do when deploying, what the limits are |

**New:** `api/tests/security.php` (55 tests), `tests/security.test.mjs` (30),
`tests/db-permissions.test.mjs` (3), `SECURITY.md`.

**Unchanged on purpose:** `api/sync.php` (verified correct under attack — the
space comes from the session, every value is bound, quotas and LWW hold),
`app/js/services/crypto-service.js`, `app/js/domain/rich-text.js`,
`app/js/ui/dom.js`, the IndexedDB schema and migrations, and every dependency.

**Changed later, outside this review** (the 2026-09-28 build pass, recorded in
`CHANGELOG.md` and pinned by the new `tests/build.test.mjs`): `webpack.config.js`,
`app/index.html` — it is now the shell *template* and names no asset, so it is
not what is served — `app/_headers`, `app/_redirects`, `Dockerfile`,
`docker/nginx/default.conf`, `docker-router.php` and `app/sw.js` (every
navigation is now answered offline, and the shell is looked up under all the
keys it can be stored at). `app/index.html` is the one name above that this
review's list got wrong: it was unchanged here, and is not any more.

---

## 11. One closing note

Nothing here is a claim that the system cannot be broken. What this review can
claim, and what the tests now enforce on every build:

- The server cannot read a record, forge a record, or cross from one space into
  another.
- No secret exists in JavaScript, in IndexedDB, in `localStorage`, in the service
  worker's cache, in a backup, in a log, or in a response.
- A cross-origin page cannot make the API do anything.
- Every input is bounded, typed, and size-checked before it reaches a handler.
- The client cannot turn stored text into markup.

Those are enforced in code, asserted in tests, and were re-attacked after every
fix. Everything listed under **Not verified** and **Residual risk** is real, and
is the honest boundary of this work.
