# AGENTS.md: OctoDeck companion extension

Engineering rules for agents working in `frontend/src/extension/`. For details, see [extension_dom_engine_design.md](../../../docs/internal/extension_dom_engine_design.md) and [extension_diagnostics_design.md](../../../docs/internal/extension_diagnostics_design.md). Repo-wide rules are in `GEMINI.md` and `frontend/GEMINI.md`.

## Goals
- Assume GitHub markup will drift. Degrade gracefully and **fail closed**: if the DOM isn't recognized, don't mutate it.
- Never break, hide or mangle GitHub's page. Every change can be undone.
- Drift is **reported** (health, badge) **and recorded** (drift records with a fingerprint) so the contract can be updated.

## Layering (enforced by `__tests__/layering.test.ts`)
- `content/features/` → `content/capabilities/` → `content/variants/` + `content/dom/resolver.ts`.
- Features never use selectors, `variants/` or the resolver. Capabilities contain no GitHub selector literals.
- Selectors live only under `content/variants/**`. Anchor locators go in `variants/<id>/anchors.ts` and `detect.ts`. Behavioral selectors (load controls, badge icons, the action classifier) go in that variant's adapters or `variants/shared.ts`. Each anchor is declared once in `dom/anchors.ts` with a cardinality, presence per page kind and an optional `absentWhen`.
- Primary selectors use stable hooks: ids, `data-testid`, ARIA, `data-*`, Rails `js-*`, Primer CSS, and GraphQL node-id typename prefixes (`IC_`, `PRR_`, ...). Never hashed classes (`prc-*-abc12`, `name__hash`). `[class*=]` is allowed only as a fallback, marked `// fragile`. English text matching must be marked `// i18n-fragile`.

## Markup variants
- New or A/B GitHub markup gets a new `variants/<id>/` module (detectors, locators, adapters), registered in `variants/index.ts`. Features don't change.
- Detection is per scope (`page`, `timeline`, `sidebar`, `composer`). Two candidate variants, or more than one match for a single-cardinality anchor, means ambiguous, which fails closed.
- Each scope root must contain the insertion points used in that scope.

## Mutating the page
- Only through `ctx.ledger`: `create`, `insert`, `addClass`/`removeClass` (`octodeck-gh-*` only), `setData` (`data-octodeck-*` only), `cloneForDisplay`.
- Own nodes carry `data-octodeck`. Never add inline styles, never remove/move GitHub nodes, never set `innerHTML` on them, never reuse GitHub class names on our nodes.
- There is one revert path (`ledger.revert`/`revertAll`). After unmount, `outerHTML` must be byte-identical to before.
- CSS lives in `content/styles/{engine,features,navigation}.css`. Hiding rules must be scoped `html:not([data-octodeck-safe])`.

## Lifecycle
- Features are registered as factories (`FeatureRegistration.create()`), so each mount gets a fresh instance.
- Use `ctx.signal`, `ctx.guard`, `ctx.setTimer`/`ctx.delay`, `ctx.onScopeChange`, `ctx.bus` and `ctx.send`. No raw listeners, timers, observers or `chrome.runtime` calls. All of these become no-ops after abort (`ctx.send` never settles after abort).
- The host trips a circuit breaker on a mount exception, on 3 guarded errors in 30s, or when the ledger's re-inject budget is exceeded (more than 5 re-insertions after external removal in 10s).
- Features talk only through bus events (`item:updated`, `timeline:loading`, `reveal:request`, ...), never by importing each other.

## Diagnostics
- `ctx.report(diagnostic)` takes `DiagnosticCode`s from `types.ts`. The host turns them into per-session outcomes: `ok`, `drifted`, `unrecognized`, `disabled`, `notApplicable`.
- Drift: a fallback selector was used, an anchor or scope was missing or ambiguous, an unknown kind appeared, a text heuristic was used, or a GitHub control didn't behave (`LOADMORE_FAILED`/`NO_PROGRESS`).
- Not drift: `ANCHOR_NOT_FOUND`, user aborts, and legitimately absent anchors (presence/`absentWhen`, e.g. signed out or a subtab).
- Fingerprints never contain page text. Ids appear only when they're in the contract's allowlist.

## Adding a feature
1. Add `content/features/<name>.ts` that exports a `FeatureRegistration`, and list it in `FEATURES` in `content.ts`.
2. Declare `kind`, `pages` and `requires` (scopes). Mutators only mount once their scopes are recognized.
3. If a capability is missing, add it to `capabilities/types.ts` and implement it in the variants. Don't reach into the DOM.
4. Test on fakes (`__tests__/fakes/{capabilities,context}.ts`) and on fixtures. Keep `layering`, `contract`, `invariants` and `chaos` green.
5. Anything user-facing (UI, defaults, alerts, behavior changes) is the user's decision. Ask first.

## Fixtures and tests
- To add a page: save it with the extension disabled, run `frontend/scripts/sanitize-github-fixture.mjs`, then add `__fixtures__/<name>.html` plus a `.meta.json` `expect` block (scopes, anchors, items, human/bot comment ids, hidden). See `__fixtures__/README.md`.
- `contract.test.ts` fails on any fallback, ambiguous or expected-missing resolution. When GitHub changes, update the primary selector and demote the old one to a fallback.
- `invariants.test.ts`: no foreign mutations, exact revert, no drift on clean fixtures, a single instance after overlapping navigations. `chaos.test.ts`: broken markup fails closed with the right diagnostics.

## User-decided behavior to guard
- Reviews with comments are never collapsed. Rows with a body are never hidden.
- Hide events hides only allowlisted bodiless `event`/`commit` rows. `unknown` and `otherEvent` stay visible.
- `/apps/` authors count as bots, and the viewer never does.
- Expand all is manual: 25 batches, 400ms apart, using GitHub's own controls only. Never `form.submit()` or direct fetches.
- A view counts after 3s of the tab being visible and focused. Safe mode turns all mutators off.
