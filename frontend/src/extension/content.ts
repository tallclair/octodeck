/**
 * Content-script entry: builds the GitHub DOM engine with the registered markup variants and
 * features, then starts it (docs/internal/extension_dom_engine_design.md section 3).
 *
 * Adding a feature means adding a module under content/features/ and listing its registration
 * here; adding a markup variant means adding a module under content/variants/ and listing it in
 * content/variants/index.ts.
 */
import { buildCapabilities } from './content/capabilities/build';
import { computePageFacts } from './content/capabilities/page';
import { fingerprint, idsFromSelectors } from './content/dom/fingerprint';
import { createDiagnosticsClient } from './content/engine/diagnosticsClient';
import { Engine, type EngineDeps } from './content/engine/engine';
import type { FeatureRegistration } from './content/engine/types';
import { ackButton } from './content/features/ackButton';
import { actionTrackerFeature } from './content/features/actionTracker';
import { anchorNavFeature } from './content/features/anchorNav';
import { expandAllFeature } from './content/features/expandAll';
import { noiseCollapser } from './content/features/noiseCollapser';
import { sidebarWidget } from './content/features/sidebarWidget';
import { timelineMarkers } from './content/features/timelineMarkers';
import { viewTrackerFeature } from './content/features/viewTracker';
import { VARIANTS } from './content/variants';
import type { VariantModule } from './content/variants/types';

/** Feature registrations; mount order is refined by each feature's `after` list. */
export const FEATURES: readonly FeatureRegistration[] = [
  viewTrackerFeature,
  actionTrackerFeature,
  sidebarWidget,
  ackButton,
  noiseCollapser,
  timelineMarkers,
  expandAllFeature,
  anchorNavFeature,
];

/** Ids that appear in the contract's own selectors are the only ids fingerprints may show. */
function contractIds(variants: readonly VariantModule[]): Set<string> {
  const selectors: string[] = [];
  for (const v of variants) {
    for (const loc of Object.values(v.anchors)) if (loc) selectors.push(...loc.selectors);
    for (const det of Object.values(v.detectors)) if (det) selectors.push(...det.root.selectors, ...(det.confirm ?? []));
  }
  return idsFromSelectors(selectors);
}

/** Builds the production engine; tests may override dependencies (e.g. settleMs, features). */
export function createContentEngine(overrides: Partial<EngineDeps> = {}): Engine {
  const knownIds = contractIds(VARIANTS);
  return new Engine({
    variants: VARIANTS,
    features: FEATURES,
    computePageFacts: (url, doc, variants) => computePageFacts(url, doc, variants),
    buildCapabilities,
    createDiagnostics: (messenger) =>
      createDiagnosticsClient({
        send: (msg) => messenger.send(msg),
        setTimer: (cb, ms) => setTimeout(cb, ms),
        clearTimer: (t) => clearTimeout(t),
      }),
    fingerprint: (root) => fingerprint(root, { knownIds }),
    ...overrides,
  });
}

// Auto-run when loaded as the content script in a browser.
if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime?.id) {
  createContentEngine().start();
}
