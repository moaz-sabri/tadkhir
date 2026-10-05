# Pull request

**What this changes**

<!-- And why this way. -->

**Related issue**

Closes #

**Tests**

- [ ] `npm test` passes
- [ ] New behaviour is covered by a test that fails without this change
- [ ] User-facing text added in **both** English and Arabic (`npm run check:i18n`)
- [ ] `docker compose run --rm --entrypoint nginx web -t` run, if nginx config changed

**Checklist**

- [ ] No runtime dependency added (`dependencies` stays empty)
- [ ] No analytics, tracking, or telemetry
- [ ] Local-first operation preserved; nothing new requires a network
- [ ] `CHANGELOG.md` updated if this changes what the software does
- [ ] No secrets, personal data, or local files included
