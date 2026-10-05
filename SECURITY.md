# Security Policy

## Reporting a vulnerability

**Please do not report a security vulnerability in a public GitHub issue, a
discussion, or a pull request.** A public report gives an attacker the details
before a fix exists.

Report it privately through <https://moazsabri.org>.

Please include:

- What the vulnerability is, and what an attacker gains from it
- Steps to reproduce, or the request that triggers it
- The Tadkhir version, the browser or client, and the deployment (Docker, or
  nginx + PHP-FPM)

You can expect an acknowledgement. If a report turns out not to be a
vulnerability, that is fine and will not be treated as a bad report.

## What is in scope

Tadkhir stores personal data and, when sync is enabled, sends it to a server.
Both paths are in scope:

- The sync API (`api/`), its authentication, and its rate limiting
- The client's encryption, key handling, and local storage
- The service worker and anything it caches
- The deployment: `Dockerfile`, `docker/`, `deploy/hosting-nginx.conf`,
  `docker-router.php`
- The client-side handling of stored text

Out of scope:

- Vulnerabilities in a browser itself
- Missing hardening that has no working exploit path
- Denial of service from a deliberately huge request, beyond what the documented
  size and rate limits already bound
- Reports generated only by an automated scanner, with no demonstrated impact

## Known limits

These are design decisions, not bugs, and they are the honest boundary of what
this software protects:

- **There is no password recovery.** No reset, no recovery. A lost password means
  the sync space cannot be opened from a new device. Records already on your
  other devices are unaffected.
- **Devices holding the key trust each other.** Any device with the master key
  can write malformed records into the space. Encryption stops the server from
  reading data; it does not stop the server from storing what it is sent.
- **Rate limits are per IP.** Behind a shared address (NAT), several people can
  affect each other's budget. `RATE_MAX` and `RATE_MAX_CREATE` exist for this.
- **Clearing browser data deletes local records.** Without sync, this device is
  the only copy.

## Disclosure

Fixes land in the repository through the normal contribution process. Report a
vulnerability privately rather than opening a pull request for it.

For the full technical review of the API, the client, and the deployment, see
[`SECURITY-REVIEW.md`](SECURITY-REVIEW.md).
