# GitHub page fixtures

Sanitized snapshots of real GitHub pages, used by the extension's DOM tests. Load them with
`loadFixture(name)` from [`../__tests__/fixtureHarness.ts`](../__tests__/fixtureHarness.ts).
It replaces the jsdom document with the fixture's DOM and sets `window.location` to the
captured URL.

```ts
import { loadFixture, resetFixture } from './fixtureHarness';

afterEach(() => resetFixture());

it('finds the composer on React issue pages', async () => {
  const meta = await loadFixture('react-issue-142957');
  expect(meta.areas.composer).toBe('react');
  expect(document.querySelector('[data-testid="comment-composer"]')).not.toBeNull();
});
```

Each fixture has two files:

| File | Contents |
| --- | --- |
| `<name>.html` | The browser's serialized, post-render DOM, sanitized (see below). |
| `<name>.meta.json` | `url`, `pageKind`, `variant`, per-area `areas` variants, `capturedAt`, `signedIn`, sanitizer options, `notes`, and `expectedAnchors`: selector to match count. |

`expectedAnchors` records the anchors the content scripts depend on. `fixtures.smoke.test.ts`
asserts the counts, so any change to a fixture shows up as a reviewable diff.

## Corpus

| Fixture | Page | Variant (timeline / sidebar / composer) | Notes |
| --- | --- | --- | --- |
| `classic-pr-141014` | kubernetes/kubernetes PR #141014, Conversation tab | classic / classic / classic, inside a `react-app` shell | Has the ajax-pagination "Load more" form, review threads with inline reply forms, labels, assignments, a cross-reference, and a commits group. Trimmed to 2 entries per kind. |
| `react-issue-142957` | kubernetes/kubernetes issue #142957 | react / react / react | The viewer is the issue author. Short timeline with no "Load more". Untrimmed. |

**Missing page kinds** (please capture when convenient): classic issue, React PR conversation,
PR Files changed / Commits / Checks tabs, a long React issue with "Load more", signed-out views,
locked conversations, and pages viewed with merge or triage rights.

## Adding a fixture

1. In Chrome, **disable the OctoDeck extension**, open the page, and scroll so lazily rendered
   parts load.
2. Save it with **Save page as… → Webpage, Complete**. Only the `.html` file is used; Chrome
   records the source URL in it.
3. From `frontend/`, run:

   ```sh
   node scripts/sanitize-github-fixture.mjs ~/Downloads/page.html \
     --name react-pr-12345 --captured 2026-10-17 --notes "what is special about this page"
   ```

   For large pages, add trimming. These are the options used for `classic-pr-141014`:

   ```sh
   --max-per-kind 2 --max-thread-entries 1 --max-thread-comments 2 --slim-chrome
   ```

   Run `node scripts/sanitize-github-fixture.mjs --help` for all options.
4. Review the output. Run `grep -i <your-login>` on it (it should return nothing) and check the
   size (aim for under ~300 KB; the smoke test fails above 400 KB).
5. Run `npm test` and commit both files.

Re-running the script on the same input is deterministic. If you change the sanitizer, regenerate
every fixture and review the `expectedAnchors` diffs.

## What the sanitizer removes

- `<script>` elements, except the `react-app` embeddedData JSON. That blob is pruned to identity
  fields (`relayId`, `id`, `number`, `title`, `state`, repository name/owner) with viewer, author,
  feature-flag and channel data removed.
- Styles, stylesheets/preloads, `<template>`, `<iframe>`, `<noscript>`, HTML comments and SVG
  path data. `<svg>` elements and their octicon classes are kept, because timeline classification
  uses them.
- Meta tags other than routing, repository and variant signals.
- The site-wide header and footer, unless `--keep-global-chrome` is given.
- Image sources, inline styles, analytics and telemetry attributes, CSP nonces and SRI hashes.
- Secrets: CSRF/authenticity tokens, signed socket channels and other secret-named attributes are
  replaced with `REDACTED`.
- The viewer's login (everywhere, including hrefs, hovercard URLs and derived ids), display name,
  and GraphQL/numeric account ids. They are replaced with `octodeck-viewer` / `OctoDeck Viewer`.
  "Viewer is the author" semantics are preserved.

Everything structural is kept: ids, `data-*` attributes, aria attributes, classes (including
hashed CSS-module classes) and text content.
