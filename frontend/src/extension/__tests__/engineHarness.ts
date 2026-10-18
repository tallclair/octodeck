/**
 * Helpers for whole-engine tests on real fixtures (invariant and chaos suites): a chrome stub
 * with a scripted background, a DOM mutation recorder, and engine start/settle helpers.
 */
import { vi } from 'vitest';
import type { ExtensionMessage, ExtensionResponse, FeatureReport } from '../types';
import { createContentEngine } from '../content';
import type { Engine } from '../content/engine/engine';
import { INSTANCE_ATTR, OWN_ATTR } from '../content/engine/constants';

export interface BackgroundStub {
  readonly messages: ExtensionMessage[];
  readonly reports: FeatureReport[];
}

/** Installs a chrome stub whose background answers like an online daemon that doesn't track the item. */
export function stubChrome(opts: { hideEvents?: boolean } = {}): BackgroundStub {
  const messages: ExtensionMessage[] = [];
  const reports: FeatureReport[] = [];
  const respond = (msg: ExtensionMessage): ExtensionResponse => {
    switch (msg.type) {
      case 'GET_HIDE_EVENTS':
        return { ok: true, data: Boolean(opts.hideEvents) };
      case 'GET_KNOWN_BOTS':
        return { ok: true, data: [] };
      case 'GET_ITEM':
        return { ok: false, error: 'item not found' };
      case 'REPORT_DIAGNOSTIC':
        reports.push(msg.report);
        return { ok: true, data: null };
      default:
        return { ok: true, data: null };
    }
  };
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test',
      lastError: undefined,
      sendMessage: (msg: ExtensionMessage, cb?: (r: ExtensionResponse) => void) => {
        messages.push(msg);
        const res = respond(msg);
        if (cb) queueMicrotask(() => cb(res));
      },
    },
    storage: {
      local: { get: (_keys: unknown, cb: (r: Record<string, unknown>) => void) => cb({}) },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  });
  // Seed the content-side cache so hide-events applies from the first render.
  localStorage.setItem('octodeck_hide_events', String(Boolean(opts.hideEvents)));
  return { messages, reports };
}

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const running: Engine[] = [];

/** Shuts down every engine started by startEngine (call from afterEach so failures can't leak listeners). */
export function shutdownAll(): void {
  for (const engine of running.splice(0)) engine.shutdown();
}

/** Starts the production engine with a short settle window and waits for it to settle. */
export async function startEngine(settleMs = 50): Promise<Engine> {
  const engine = createContentEngine({ settleMs });
  running.push(engine);
  engine.start();
  // Settle polling runs every 250ms; give mounts and the first diagnostics flush time to finish.
  await wait(settleMs + 700);
  return engine;
}

/** Snapshot of the document without the engine's persistent instance token. */
export function snapshot(): string {
  const clone = document.documentElement.cloneNode(true) as Element;
  clone.removeAttribute(INSTANCE_ATTR);
  return clone.outerHTML;
}

export interface Violations {
  foreignAdds: string[];
  foreignRemovals: string[];
  foreignAttrChanges: string[];
}

function describeEl(el: Element): string {
  return `<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} class="${(el.getAttribute('class') ?? '').slice(0, 60)}">`;
}

function isOwn(node: Node): boolean {
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return Boolean(el?.closest(`[${OWN_ATTR}]`)) || Boolean(node.nodeType === 1 && (node as Element).hasAttribute(OWN_ATTR));
}

/**
 * Records every DOM mutation and classifies those that break the ledger rules: added or removed
 * non-OctoDeck nodes, and attribute changes on GitHub nodes other than octodeck-gh-* classes and
 * data-octodeck-* attributes. (No GitHub scripts run in jsdom, so every mutation is ours.)
 */
export function recordMutations(): { stop(): Violations } {
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((r) => records.push(...r));
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true });
  return {
    stop(): Violations {
      records.push(...observer.takeRecords());
      observer.disconnect();
      const v: Violations = { foreignAdds: [], foreignRemovals: [], foreignAttrChanges: [] };
      for (const r of records) {
        if (isOwn(r.target)) continue;
        if (r.type === 'childList') {
          for (const n of Array.from(r.addedNodes)) if (!isOwn(n) && n.nodeType === 1) v.foreignAdds.push(describeEl(n as Element));
          for (const n of Array.from(r.removedNodes)) {
            if (n.nodeType === 1 && !(n as Element).hasAttribute(OWN_ATTR)) v.foreignRemovals.push(describeEl(n as Element));
          }
        } else if (r.type === 'attributes') {
          const el = r.target as Element;
          const name = r.attributeName ?? '';
          if (name.startsWith('data-octodeck')) continue;
          if (name === 'class') {
            const before = new Set((r.oldValue ?? '').split(/\s+/).filter(Boolean));
            const after = new Set((el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean));
            const changed = [...before, ...after].filter((c) => before.has(c) !== after.has(c));
            if (changed.every((c) => c.startsWith('octodeck-gh-'))) continue;
          }
          v.foreignAttrChanges.push(`${describeEl(el)} ${name}`);
        } else if (r.type === 'characterData') {
          v.foreignAttrChanges.push(`text change in ${describeEl(r.target.parentElement ?? document.body)}`);
        }
      }
      return v;
    },
  };
}

export function ownNodes(feature?: string): Element[] {
  return Array.from(document.querySelectorAll(feature ? `[${OWN_ATTR}="${feature}"]` : `[${OWN_ATTR}]`));
}

/** True when the element or an ancestor carries an OctoDeck hiding class. */
export function isHiddenByOctoDeck(el: Element): boolean {
  return Boolean(el.closest('.octodeck-gh-hidden-event, .octodeck-gh-collapsed-comment'));
}
