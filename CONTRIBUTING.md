# Contributing to Tadkhir

Thanks for looking at Tadkhir.

**Contributions should improve Tadkhir without making Tadkhir unnecessarily
complicated.**

That sentence is the review criterion. Tadkhir is deliberately small and
local-first, and most feature requests that are perfectly reasonable for other
projects do not belong here. If you are unsure whether a change fits, open an
issue and ask before writing it.

## How the project works

Tadkhir is a PWA: plain ES modules in the browser, with no framework and no
runtime dependencies, plus a small PHP + SQLite API used only for optional sync.

```
app/js/ui/          screens and components
app/js/services/    business logic
app/js/domain/      pure logic, no I/O
app/js/data/        repositories over IndexedDB
app/js/app/         router, event bus, sync loop
api/                PHP front controller, auth, sync, SQLite
tests/              node:test client tests
api/tests/          PHP HTTP integration tests
```

Your data lives in IndexedDB in the browser. That is the primary store; the
server is optional. Nothing about the basic use of Tadkhir needs a network.

Read [`README.md`](README.md) for the architecture overview and
[`PLAYBOOK.md`](PLAYBOOK.md) for the detailed implementation notes.

## Getting started

```sh
npm ci
npm run build        # build frontend assets into app/dist/
npm run dev          # build, then serve app + API on http://127.0.0.1:8080
```

You need Node.js >= 20 and PHP >= 8.0 with `pdo_sqlite` and `mbstring`. Docker
is an alternative to installing PHP locally.

## Running the tests

```sh
npm run build        # first, on a fresh checkout — see the note below
npm test             # everything: client tests, i18n check, API tests
npm run test:client  # node --test tests/*.test.mjs
npm run check:i18n   # every literal string key must exist in both en and ar
npm run test:api     # php api/tests/run.php
```

**A pull request with failing tests will not be merged.** Run `npm test`
before you open it.

Run the build first. Four assertions in `tests/build.test.mjs` read `app/dist/`
and skip themselves when it is absent, so on a fresh checkout `npm run
test:client` reports 608 passed and 4 skipped. CI builds first for this reason.

## CI

Every push and pull request runs `.github/workflows/ci.yml`, in two jobs:

- **`verify`** — `npm ci`, `npm run build`, the three test commands above, then a
  check that `app/dist/` is a releasable artifact.
- **`docker`** — `docker build --target test .`, `docker compose config`,
  `docker compose build`, and `nginx -t`.

CI runs the same commands you do, on Node 22 and PHP 8.5 — the versions the
Docker images use. It needs no secrets, has read-only permissions, and deploys
nothing.

**Green CI is required to merge.** It runs on Node 22, so a change that passes
locally on a different version can still fail there. If CI fails and your
machine is green, the failure is real; reproduce it with Node 22 rather than
adjusting the test.

`deploy/hosting-nginx.conf` is not validated by nginx in CI — it is a hosting
panel template full of `{{…}}` placeholders. It stays part of release
verification.

If you changed `docker/nginx/default.conf`, also run the real parser, which no
test can replace:

```sh
docker compose run --rm --entrypoint nginx web -t
```

## Working on a change

The upstream repository does not accept direct pushes to `master`. The flow is:

```
Fork
↓
Branch
↓
Changes
↓
Tests
↓
Pull Request
↓
Review
↓
Merge
```

```sh
git checkout -b my-change
# …make the change…
npm test
git push origin my-change
```

Then open a pull request from your fork.

## What a pull request should contain

- **A clear description** of what changes and why.
- **Tests.** A change to behaviour comes with a test that fails without it. The
  existing tests are written to state *why* a rule exists, so match that: explain
  the reason, not just the mechanism.
- **Both languages** if you touch user-facing text. English and Arabic live in
  `app/js/i18n/strings.js`, and `npm run check:i18n` enforces that every key
  exists in both.
- **A `CHANGELOG.md` entry** under the unreleased section, if it changes what
  the software does.

## What we will ask you to change

- **A dependency added for convenience.** Tadkhir ships no runtime dependencies,
  and that is enforced by a test. The reasoning is in the comment on that test:
  a runtime dependency turns the bundle into a package manager's output, and the
  cost is paid on the worst possible connection by the user who can least afford
  it. Build-time tools are fine.
- **A feature added because it is possible.** "We could add…" is not a reason.
  Ask first.
- **A rewrite.** A small project stays understandable when changes are small.
- **Anything that weakens local-first operation**, moves data to a server that
  did not need it, or makes the app depend on a network connection for its basic
  function.
- **Analytics, tracking, or telemetry.** Not part of this project.
- **A framework, or a UI library.** The UI is hand-built from `app/css/` and
  `app/js/ui/`.

## Privacy

If your change touches stored data, encryption, key handling, sync, backups, or
the service worker cache, treat it as a security-sensitive change and say so in
the pull request. The properties the project holds to are:

- The server cannot read a record.
- No secret is reachable from JavaScript, `localStorage`, IndexedDB, or the cache.
- The service worker caches an allowlist, and never `/api/`.
- Stored text cannot become markup.

`SECURITY.md` covers how to report a vulnerability. Do not report one through a
pull request.

## Code of Conduct

Participation in this project is governed by
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Licence

Contributions are accepted under the terms of the
[AGPL-3.0-or-later](LICENSE) licence that covers the rest of the project.
