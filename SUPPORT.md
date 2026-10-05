# Support

Tadkhir is a self-hosted, local-first application. There is no company behind it,
no support contract, and no account to open a ticket against.

## Where to ask

| You want to… | Go to |
|---|---|
| Report something that does not work | [A bug report](https://github.com/moaz-sabri/tadkhir/issues/new?template=bug_report.md) |
| Suggest a behaviour change | [A feature request](https://github.com/moaz-sabri/tadkhir/issues/new?template=feature_request.md) |
| Ask how to install, host, or configure it | [Discussions](https://github.com/moaz-sabri/tadkhir/discussions) |
| **Report a security vulnerability** | **[`SECURITY.md`](SECURITY.md) — privately, never a public issue** |
| Contribute code or documentation | [`CONTRIBUTING.md`](CONTRIBUTING.md) |

Before filing anything: `npm test` reproduces most "it does not work" reports
locally, and [Troubleshooting](#self-help) covers the common ones.

## Self-help

**The app will not load / every request returns 500**

PHP is running without `pdo_sqlite` or `mbstring`. Check with
`php -m | grep -E 'pdo_sqlite|mbstring'`. On Windows, PHP often ships with no
`php.ini` at all — README → *Getting Started* → Windows note explains how to
point PHP at one.

**My records are gone**

They were in this browser's IndexedDB and not synced. Clearing site data
deletes them permanently; there is no server copy and no recovery. Turn sync on
if you want a second copy. This is a design decision, not a bug — see
`SECURITY.md` → *Known limits*.

**Sync stopped working**

The session cookie is `HttpOnly` and the master key is held in memory only.
`SECURITY.md` → *Known limits* explains what that means for a new device, and
there is deliberately no password recovery.

**Something in a shared host's nginx config rejects the app**

`deploy/hosting-nginx.conf` is a template. Every `{{…}}` placeholder must be
replaced with your hosting panel's variables, and it cannot be validated by
`nginx -t` until it is.

## What support will look like

Honestly and as far as the maintainer's time allows. Tadkhir is AGPL-3.0, so if
the answer is a change you need, you are free to make it yourself and publish
it. Nobody is obliged to keep this running for you.