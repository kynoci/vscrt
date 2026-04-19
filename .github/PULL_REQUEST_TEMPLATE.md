<!--
Thanks for the contribution! A quick sanity checklist below helps
reviewers land the PR fast. Delete sections that don't apply.
-->

## Summary

<!-- One or two sentences: what changes, why. -->

## Screenshots / demo

<!-- For UI/webview changes. Drag a PNG or GIF straight into this box. -->

## Test coverage

- [ ] Unit test(s) added under `src/test/*.test.ts`
- [ ] Integration test(s) added under `src/test/integration/` (for new commands)
- [ ] Perf budget updated under `src/test/perf/` (for hot-path changes)
- [ ] Manually verified in the Extension Development Host (F5)

## Checklist

- [ ] `npm run check-types` passes
- [ ] `npm run lint` passes
- [ ] `npm run test:unit` passes
- [ ] `CHANGELOG.md` updated under `## [Unreleased]` with a short bullet
- [ ] README / docs updated if user-facing behaviour changed
- [ ] For schema changes: `schemas/vscrtConfig.schema.json` updated + migration path noted
- [ ] For crypto-sensitive changes: see `SECURITY.md` scope; CODEOWNERS review required

## Related issues

<!-- e.g. "Closes #123" or "Refs #456" -->
