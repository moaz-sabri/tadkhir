# Tadkhir

[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL%20v3%20or%20later-blue.svg)](LICENSE)
[![Local-first](https://img.shields.io/badge/data-local--first-8A8A8A.svg)](CONTRIBUTING.md)
[![No runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-success.svg)](package.json)
[![PWA](https://img.shields.io/badge/PWA-installable-8A8A8A.svg)](app/manifest.webmanifest)

> العربية: [`README.ar.md`](README.ar.md) — قواعد المساهمة بالعربية: [`CONTRIBUTING.ar.md`](CONTRIBUTING.ar.md)

**Tadkhir is a simple, local-first personal application for keeping everyday tasks, sessions, expenses, subscriptions, debts, and things to revisit in one place.**

**It is built around a simple idea: when the need is simple, the tool should be simple too.**

Tadkhir focuses on simplicity, privacy, local-first use, and avoiding unnecessary
complexity.

This first public release is intentionally focused on personal use. It is not a
project management platform, team collaboration tool, accounting system, or
time-tracking SaaS.

Tadkhir is open source and intended to be useful to individuals while providing a
foundation that can evolve over time.

---

## Why Tadkhir?

Many tools try to add more features in order to become more capable, and that
often makes them more complicated to use.

Tadkhir takes a different direction:

**If the need is simple, the tool should be simple too.**

So Tadkhir focuses on gathering a limited set of everyday personal needs in one
place, with local-first operation, privacy, and as little complexity as possible.

## Features

Tadkhir is one personal system. What follows is what it is made of, grouped the way
the app groups it: first the things you act on, then the things you record, then
the layer that organises those, then the settings.

### Home

The home screen is a glance, not a dashboard. It answers six questions and no
more, and a block appears only when it has something true to say:

- the time and the date
- **Now** — the session you are running, and money that is due today or was due
  before it
- **Money this month** — this month's expenses, income, what is left of the two,
  and what is still owed
- **Time today** — today's hours against the day *you* usually keep, which is
  averaged from your own history rather than configured as a goal
- **Today** — today's habits, and the tasks worth putting in front of you
- **Recently added** — the last five things you added, across every service

Every block carries the door to the screen it summarises, so a figure is never a
dead end.

It is not a place you scroll to find out what is happening today, and it is not a
launcher: the one add button in the corner offers the four things you can record
— income, an expense, a session, a note — from anywhere in the app. The
aggregates are in Reports, where a summary belongs.

### Getting around

There is no bottom bar and no tab strip. The header carries the name and **one**
button, beside it, that opens the whole list of sections grouped by layer —
services first (Tasks, Habits, Shares and ideas, Money), then the tools that
organise them (Pages, Kanban, Sessions, Log, Reports), then Settings. The order
is the priority order and it is written down once, in `ui/components/nav.js`; the
same list is also a page at `/more` for a bookmark or a home-screen shortcut.

### Services

**Tasks** — Tasks with a time estimate, an optional planned day, and optional
subtasks. A task can be run as a session.

**Routines** (Habits) — The repeating things: run for 30 minutes every day, wash
the car on Friday, five cups of water. A timed routine is run by the app's own
timer; a counter is a number you press. Only today's routines are on the home
screen — a day you did not repeat is a day, not a debt.

**Sessions** — A timed session tied to a task, or a **Free Session** that measures
time without one. The running session is its own screen: the clock and the date
stay put at the top while the subtasks scroll underneath, and the work sits
beside the timer rather than below it where there is width for both.

**Money** — A personal area for expenses, income, recurring bills and
subscriptions, debts, and debt payments. This is a personal record, not
accounting software.

**Later** — A place for things you do not want to deal with now: an idea, a note,
a link, something to look up later. Not a knowledge management system.

### The layer that organises them

**Pages** — Notes and lists, with references to records you already have.

**Kanban** — A board over tasks, Later items and pages. It holds pointers, never
copies, so a card cannot become a second version of a record.

**Log** — What happened, day by day: sessions that ended, money in and out, days
a counter recorded, tasks you closed, items you followed up. It holds **no record
of its own** — every line is derived from the records the services already keep,
so it cannot fall behind them and there is nothing extra to export or sync.

**Reports** — Where your time and your money actually went, over a period you
choose.

### Settings

Language, export, import, sync, and the device. Last on purpose: a settings
screen is something a person visits deliberately, while a service is something
they open in order to work. The navigation states that order — it is one list,
read in sequence, with the settings at the end of it.

**Installable** — A PWA. Works offline through a service worker, and the app can
be installed on a phone or desktop.

## What Tadkhir is not

Tadkhir is not:

- A project management platform
- A team collaboration tool
- A time-tracking SaaS
- Accounting software
- A knowledge management system
- A social network
- A replacement for every productivity application

It is not trying to be a comprehensive alternative to every tool that exists. The
idea is smaller:

**Why use Tadkhir instead of another application?**

Because simplicity is enough when the need is simple.

## Principles

**Simplicity** — Simplicity matters more than the number of features.

**Local-first** — The primary use must work locally. The app does not depend on
an internet connection for its basic function.

**User-owned** — Your records live on your device, in this browser's IndexedDB.
Sync is optional, off by default, and end-to-end encrypted; the server stores
ciphertext and holds no key. Export and import are a first-class path, not a
setting: `Export → save the file → Import → restore`. Nothing is held hostage to
the service.

**Privacy** — Your personal data should not become a product in itself. The
optional sync server stores ciphertext it cannot read.

**No unnecessary complexity** — A feature or a system is not added just because
it could be added.

### The question asked of every addition

Before a screen, a service or a piece of interface goes in:

1. Does a person actually need it?
2. Can it be done more simply?
3. Does it belong on the front, or inside the section that owns it?
4. Is it value, or is it just more options?
5. What does it cost Tadkhir in speed and clarity?
6. Does it keep the user's data theirs?

If it is not necessary, it does not go in. Two consequences are worth naming,
because both have been applied here:

- **One screen answers one question.** The home screen is about *now*; everything
  that only makes sense in aggregate lives in Reports. The Log answers "what did I
  do" across every service, and holds no record of its own so it cannot disagree
  with them.
- **A figure that can be negative carries its sign.** A net that printed its
  absolute value would turn a loss into a gain.

## Current version

This release represents the first complete public version of Tadkhir. It is
intentionally focused and simple. Future development may expand the project, but
simplicity, local-first operation, privacy, and avoiding unnecessary complexity
remain core principles.

## Getting Started

Requirements:

- **Node.js >= 20** (see `engines` in `package.json`) to build the frontend
- **PHP >= 8.0** with the `pdo_sqlite` and `mbstring` extensions to run the API
- **Docker + Docker Compose** (optional) for the full containerised setup

### Local development

```sh
npm ci
npm run build        # webpack --mode production -> app/dist/
npm run dev          # builds, then serves app + API on http://127.0.0.1:8080
```

`npm run dev` runs PHP's built-in server with `docker-router.php`, which serves
the SPA and the API on the same origin — the recommended arrangement, because it
removes CORS from the picture entirely.

To serve without the build step running first, run it directly:

```sh
php -d enable_post_data_reading=0 -S 127.0.0.1:8080 -t app docker-router.php
```

> The `-d enable_post_data_reading=0` is what lets the app receive a photo or a
> file shared from the phone's share sheet. It is already set for you by
> `npm run dev`, and in `docker/php/php.ini` for the container. Without it
> everything else works; only file sharing falls back to the attachment picker.

> **Windows note.** Some PHP installations on Windows ship without a `php.ini`,
> so `pdo_sqlite` and `mbstring` are not loaded and every API request returns
> `500 Internal Server Error`. Create a small config file and point PHP at it:
> ```sh
> setx PHPRC "C:\Users\<your-user>\.php"
> ```
> with a `php.ini` in that directory containing:
> ```ini
> extension_dir = "C:\Program Files\php\ext"
> extension=php_pdo_sqlite.dll
> extension=php_sqlite3.dll
> extension=php_mbstring.dll
> ```
> Adjust `extension_dir` to match your PHP installation, reopen the terminal, and
> check with `php -m | findstr pdo_sqlite`.

## Docker

```sh
docker compose up --build
# web listens on ${PORT:-8080}; the healthcheck is GET /api/health
```

- The `sync-data` volume holds the SQLite file at `/app/api/var`.
- `docker-compose.override.yml` bind-mounts `./app` and `./api` for local
  development.

Verify an nginx config change with the real parser before trusting it:

```sh
docker compose run --rm --entrypoint nginx web -t
```

### Hosting without Docker

`deploy/hosting-nginx.conf` is the container's own server for nginx + PHP-FPM on
a shared host. Replace `{{server_name}}` with your host; the other `{{…}}`
placeholders are filled in by the hosting panel's template variables.

Upload only these:

| Upload | Why |
|---|---|
| `app/dist/` | Built assets, including `app/dist/index.html` (the served shell) |
| `app/icons/` | PWA icons |
| `app/manifest.webmanifest` | Required for PWA install and the share target |
| `app/sw.js` | Offline operation |
| `api/index.php` `config.php` `db.php` `auth.php` `sync.php` `gc.php` | The API |
| `api/var/` | **Empty**, writable by the PHP user; the SQLite file is created here |

Everything under `app/js`, `app/css` and `app/index.html` is a build input, not
a deployed part: the config refuses `/app/` over HTTP entirely.

## Development

```sh
npm run build          # production build -> app/dist/
npm run dev            # build + PHP dev server
```

The frontend is plain ES modules with **no framework and no runtime
dependencies**. `webpack` bundles it into `app/dist/` as content-hashed
`app.<hash>.js` and `app.<hash>.css`. `app/index.html` is a template that names no
assets; the build injects the hashed names into `app/dist/index.html`, which is
what the server hands out.

## Testing

```sh
npm test               # test:client, then check:i18n, then test:api
npm run test:client    # node --test tests/*.test.mjs
npm run check:i18n     # every literal key exists in both en and ar
npm run test:api       # php api/tests/run.php — HTTP integration tests
```

Also available:

```sh
php api/gc.php --dry-run   # preview tombstone cleanup, delete nothing
```

Run `npm run build` before `npm run test:client` if you want the full 612. Four
assertions in `tests/build.test.mjs` read `app/dist/` and skip themselves when it
is missing, so on a fresh checkout the suite reports 608 passed and 4 skipped.

### CI

GitHub Actions runs on every push and pull request
(`.github/workflows/ci.yml`), in two jobs:

| Job | What it runs |
|---|---|
| `verify` | `npm ci`, `npm run build`, `npm run test:client`, `npm run check:i18n`, `npm run test:api`, then checks that `app/dist/` is a releasable artifact |
| `docker` | `docker build --target test .`, `docker compose config`, `docker compose build`, `nginx -t` |

Every step is the same command you run locally, on Node 22 and PHP 8.5 — the
versions the Docker images use. The workflow has read-only permissions, needs no
secrets, and never deploys anything.

The `docker` job is not a repeat of `verify`: it runs the client suite on
`node:22-alpine` inside the image, which is the only place it runs on Alpine,
and `nginx -t` uses the real nginx parser, which no test can replace.

Two things CI deliberately does **not** cover:

- **`deploy/hosting-nginx.conf` is not parsed by nginx.** It is a template full
  of a hosting panel's `{{…}}` placeholders, so nginx cannot read it until they
  are filled in on that host. It stays part of release verification.
- **Deployment.** Nothing here publishes anything.

## Architecture

```
Frontend (PWA, ES modules, no framework)
   ↓
Local storage (IndexedDB)  ← the primary store
   ↓
Application logic (services / domain / repositories)
   ↓
Optional sync  →  API (PHP, single front controller)
   ↓
SQLite (PDO)
```

**Frontend** — Plain ES modules under `app/js/`, layered as `ui/` (pages and
components), `services/` (business logic), `domain/` (pure logic), `data/`
(repositories over IndexedDB), and `app/` (router, event bus, sync loop, service
worker registration). No framework, no runtime dependency.

**Local data** — IndexedDB, database `task-timer`, version 7, with per-store
migrations in `app/js/data/migrations.js`. This is the primary store: the app is
fully usable with no server at all.

**Derived, never stored** — The figures on the home screen, the Reports page and
the Log are all computed on read from records that already exist, in
`domain/analytics.js`. Nothing is cached and no total is persisted, so a figure can
never disagree with the list it was computed from. The Log goes further and has no
store at all: its lines are the sessions, transactions, counter days, closed tasks
and followed-up items that the services already keep, which is why it adds nothing
to export, sync or reconcile.

**Sessions and events** — A session moves through `running → paused →
completed/cancelled`, recording time `segments` and `events`. A running session
is device-local and is never synced; only the final record is.

**Sync** — Optional and off by default. Local changes go into an `outbox`,
records are encrypted with AES-256-GCM before they leave the device, and batches
are pushed and pulled. Conflicts resolve last-write-wins on `updatedAt`; deletes
propagate as tombstones.

**API** — PHP with no framework. `api/index.php` is a single front controller
that routes on an exact path match and is the only entry point under `/api/`.
`api/auth.php` handles spaces, sessions and rate limiting; `api/sync.php` handles
push and pull; `api/db.php` owns the PDO connection and schema;
`api/config.php` reads environment variables and an optional
`api/config.local.php`.

**Authentication** — A sync space is identified by a `space` code and a password.
Passwords are hashed with argon2id (bcrypt fallback), sessions are HttpOnly
`SameSite=Lax` cookies, and every handler derives the space from the cookie
rather than from the request body.

**Storage** — Server-side SQLite at `api/var/sync.sqlite` (configurable via
`DATABASE_PATH`), in WAL mode with foreign keys on. It holds ciphertext.

**Docker** — A multi-stage `Dockerfile`: Node builds the assets, `php:8.5-fpm-alpine`
runs the API as a non-root user, and `nginx-unprivileged` serves the frontend and
proxies `/api/`.

Configuration is read from environment variables, with an optional
`api/config.local.php` (gitignored; see `api/config.local.php.example`). No
configuration is needed for a same-origin deployment.

## Privacy

- **Local by default.** Your records live in this browser's IndexedDB. Using the
  app does not require an account, a server, or a network connection.
- **No analytics, no tracking.** There is no analytics script, no telemetry, and
  no third-party requests of any kind. The only network calls the app makes are
  to its own origin, and only for sync.
- **End-to-end encrypted sync.** Records are encrypted in the browser with
  AES-256-GCM before they are sent. The server stores ciphertext and holds no
  key, so it cannot read your data.
- **The server session cookie is `HttpOnly`.** JavaScript cannot read it. The
  master key is a non-extractable `CryptoKey` held in memory only.
- **No password recovery, by design.** There is no reset path. A lost password
  means the space cannot be opened from a new device, while records already on
  your other devices are unaffected.

`SECURITY.md` explains how to report a vulnerability. For the full technical
review of the sync API, the client, and the deployment, see
[`SECURITY-REVIEW.md`](SECURITY-REVIEW.md).

## Open Source

Tadkhir is open source. You may use it personally, fork it, contribute to it, and
build derived versions under the terms of the licence.

The upstream repository does not accept direct pushes to `master`. Contributions
go through:

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

See [CONTRIBUTING.md](CONTRIBUTING.md).

CI runs on every push and pull request and must be green before a change can
merge. See [Testing → CI](#ci).

## Contributing

Contributions should improve Tadkhir without making Tadkhir unnecessarily
complicated. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first — it covers how
to run the project, how to run the tests, and what a pull request is expected to
contain. Arabic: [CONTRIBUTING.ar.md](CONTRIBUTING.ar.md).

You do not need permission to fork, modify, or publish your own version. What
the licence does require is that the licence and the copyright notice travel
with the code — see [NOTICE](NOTICE). Contribution back to the upstream
repository is welcome and credited, never expected.

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Security

Please do not report a security vulnerability in a public issue. See
[SECURITY.md](SECURITY.md) for how to report one privately.

## Support

There is no company behind Tadkhir and no support contract. [SUPPORT.md](SUPPORT.md)
says where to ask, and covers the problems people hit most often.

## License

Tadkhir is licensed under the **GNU Affero General Public License v3.0 or later**.

SPDX identifier: `AGPL-3.0-or-later`

The AGPL *is* the GNU General Public License v3, with one section added. It is
the same copyleft, the same freedoms, the same reciprocal obligation — so if you
came here expecting "GPL v3", this is it. AGPL-3.0 is what SPDX calls a GPL-family
licence, and it is the only licence that covers this software: it is not an
alternative to GPL-3.0, it does not weaken it, and you cannot offer Tadkhir under
both without stating two conflicting terms for one work.

The AGPL was chosen over MIT and GPL-3.0 because the intent is that derived
projects stay open source, including when they are offered as a network service.
GPL-3.0 leaves that case open: a modified Tadkhir served over HTTP without being
distributed carries no obligation to publish its source. Section 13 of the AGPL
closes that gap.

You may use, modify, fork, and contribute under these terms. See [LICENSE](LICENSE),
and [NOTICE](NOTICE) for what must be kept alongside it.

## Attribution

**TAM — Sabri** — <https://moazsabri.org>

All build-time dependencies are MIT-licensed and are not redistributed as part
of Tadkhir. Tadkhir has no runtime dependencies, no bundled third-party code, and no
external fonts, icons, or images. If you cite Tadkhir in academic work,
[CITATION.cff](CITATION.cff) holds the citation metadata.
