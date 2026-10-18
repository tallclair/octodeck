import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionBus } from '../content/engine/bus';
import { MutationLedger, sweepStaleOwnState, cloneForDisplay } from '../content/engine/ledger';
import { ScopedObserver } from '../content/engine/observer';
import { classifyNavigation } from '../content/engine/navigation';
import { FeatureHost, type DiagnosticsSink } from '../content/engine/featureHost';
import { Engine, type EngineDeps } from '../content/engine/engine';
import { INSTANCE_ATTR, OWN_ATTR, SAFE_ATTR } from '../content/engine/constants';
import type { Feature, FeatureRegistration, PageSession, PrefsSnapshot, PrefsSource } from '../content/engine/types';
import type { Messenger } from '../content/engine/messaging';
import type { ScopeDetection, ScopeId } from '../content/dom/types';
import type { VariantModule } from '../content/variants/types';
import { createFakeCapabilities, createFakeSidebar, fakePageFacts } from './fakes/capabilities';

const prefsStub = (over: Partial<PrefsSnapshot> = {}): PrefsSource => ({
  current: () => ({ hideEvents: false, knownBots: [], safeMode: false, ...over }),
  onChange: () => {},
  setHideEvents: () => {},
});
const messengerStub: Messenger = { send: () => Promise.resolve({ ok: false, error: 'stub' }) };

function sinkRecorder(): DiagnosticsSink & { outcomes: Array<[string, string]>; diags: Array<[string, string]> } {
  const outcomes: Array<[string, string]> = [];
  const diags: Array<[string, string]> = [];
  return {
    outcomes,
    diags,
    beginSession: () => {},
    add: (f, d) => diags.push([f, d.code]),
    setOutcome: (f, o) => outcomes.push([f, o]),
    endSession: () => {},
  };
}

function session(over: Partial<PageSession> = {}): PageSession & { controller: AbortController } {
  const controller = new AbortController();
  return { generation: 1, navId: 'n', url: new URL(location.href), facts: fakePageFacts(), signal: controller.signal, controller, ...over };
}

function reg(feature: () => Feature): FeatureRegistration {
  const f = feature();
  return { id: f.id, create: feature };
}

describe('SessionBus', () => {
  it('isolates handler errors and unsubscribes on abort', () => {
    const errors: unknown[] = [];
    const bus = new SessionBus((e) => errors.push(e));
    const c = new AbortController();
    const seen: string[] = [];
    bus.view(c.signal).on('nav:hash', () => {
      throw new Error('x');
    });
    bus.view(c.signal).on('nav:hash', (v) => seen.push(v.hash));
    bus.emit('nav:hash', { hash: 'a' });
    c.abort();
    bus.emit('nav:hash', { hash: 'b' });
    expect(seen).toEqual(['a']);
    expect(errors).toHaveLength(1);
    expect(bus.last('nav:hash')).toEqual({ hash: 'b' });
  });
});

describe('MutationLedger', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="gh"><p>t</p></div>';
  });

  it('reverts inserts, classes and data and ignores ops after abort', () => {
    const before = document.body.innerHTML;
    const ledger = new MutationLedger();
    const c = new AbortController();
    const l = ledger.forFeature('timelineMarkers', c.signal);
    const p = document.querySelector('p')!;
    const n = l.create('div');
    l.insert(n, { after: p });
    l.addClass(p, 'octodeck-gh-x');
    l.setData(p, 'octodeck-y', '1');
    c.abort();
    l.addClass(p, 'octodeck-gh-late');
    expect(p.classList.contains('octodeck-gh-late')).toBe(false);
    ledger.revert('timelineMarkers');
    expect(document.body.innerHTML).toBe(before);
  });

  it('rejects non-OctoDeck classes and foreign nodes', () => {
    const l = new MutationLedger().forFeature('ackButton', new AbortController().signal);
    expect(() => l.addClass(document.body, 'btn' as never)).toThrow();
    expect(() => l.insert(document.createElement('div'), { appendTo: document.body })).toThrow();
  });

  it('counts only external removals toward the re-inject budget', () => {
    const tripped: string[] = [];
    let t = 0;
    const ledger = new MutationLedger({ reinjectLimit: 2, now: () => t, onBudgetExceeded: (id) => tripped.push(id) });
    const l = ledger.forFeature('sidebarWidget', new AbortController().signal);
    const gh = document.getElementById('gh')!;
    // Own removals don't count.
    for (let i = 0; i < 5; i++) {
      const n = l.create('div', 'section');
      l.insert(n, { appendTo: gh });
      l.remove(n);
    }
    expect(tripped).toEqual([]);
    // External removals do.
    for (let i = 0; i < 4; i++) {
      t += 100;
      const n = l.create('div', 'section');
      l.insert(n, { appendTo: gh });
      n.remove(); // GitHub re-rendered the parent
    }
    expect(tripped).toEqual(['sidebarWidget']);
  });

  it('sweeps stale OctoDeck state left by an orphaned instance', () => {
    document.body.innerHTML = `<div class="a octodeck-gh-hidden-event" data-octodeck-group="1"></div><span ${OWN_ATTR}="x"></span>`;
    sweepStaleOwnState(document);
    expect(document.body.innerHTML).toBe('<div class="a"></div>');
  });

  it('cloneForDisplay drops nested own nodes', () => {
    const el = document.createElement('div');
    el.innerHTML = `<p id="x">a</p><span ${OWN_ATTR}="f">own</span>`;
    const clone = cloneForDisplay(el);
    expect(clone.innerHTML).toBe('<p>a</p>');
  });
});

describe('ScopedObserver', () => {
  it('attributes additions and own-node removals to scopes and ignores own-node churn', () => {
    document.body.innerHTML = '<div id="root"><div id="parent"></div></div>';
    const root = document.getElementById('root')!;
    const parent = document.getElementById('parent')!;
    const obs = new ScopedObserver({ getRoots: () => ({ sidebar: root }) });
    const changes: Array<{ added: number; removedOwn: number }> = [];
    const c = new AbortController();
    obs.subscribe('sidebar', (ch) => changes.push({ added: ch.addedElements.length, removedOwn: ch.removedOwn.length }), c.signal);

    const own = document.createElement('div');
    own.setAttribute(OWN_ATTR, 'sidebarWidget');
    parent.appendChild(own);
    const ghChild = document.createElement('span');
    parent.appendChild(ghChild);
    const ownInner = document.createElement('i');
    own.appendChild(ownInner);
    obs.ingest([
      { target: parent, addedNodes: [own] as unknown as NodeList, removedNodes: [] as unknown as NodeList } as unknown as MutationRecord,
      { target: own, addedNodes: [ownInner] as unknown as NodeList, removedNodes: [] as unknown as NodeList } as unknown as MutationRecord,
      { target: parent, addedNodes: [ghChild] as unknown as NodeList, removedNodes: [] as unknown as NodeList } as unknown as MutationRecord,
    ]);
    own.remove();
    obs.ingest([{ target: parent, addedNodes: [] as unknown as NodeList, removedNodes: [own] as unknown as NodeList } as unknown as MutationRecord]);
    obs.flush();
    expect(changes).toEqual([{ added: 1, removedOwn: 1 }]);
  });

  it('reports detached roots before delivering rootReplaced', () => {
    document.body.innerHTML = '<div id="root"></div>';
    let root: Element = document.getElementById('root')!;
    const detached: ScopeId[][] = [];
    const obs = new ScopedObserver({
      getRoots: () => ({ timeline: root }),
      onRootsDetached: (s) => {
        detached.push(s);
      },
    });
    const replaced: boolean[] = [];
    obs.subscribe('timeline', (ch) => replaced.push(ch.rootReplaced), new AbortController().signal);
    const old = root;
    old.remove();
    obs.ingest([{ target: document.body, addedNodes: [] as unknown as NodeList, removedNodes: [old] as unknown as NodeList } as unknown as MutationRecord]);
    obs.flush();
    root = document.body.appendChild(document.createElement('div'));
    expect(detached).toEqual([['timeline']]);
    expect(replaced).toEqual([true]);
  });
});

describe('classifyNavigation', () => {
  const u = (s: string) => new URL(s, 'https://github.com');
  it('distinguishes item, sub-route and hash changes', () => {
    expect(classifyNavigation(u('/o/r/pull/1'), u('/o/r/pull/2'))).toBe('item-change');
    expect(classifyNavigation(u('/o/r/pull/1'), u('/o/r/pull/1/files'))).toBe('subroute-change');
    expect(classifyNavigation(u('/o/r/pull/1'), u('/o/r/pull/1#issuecomment-5'))).toBe('hash-change');
    expect(classifyNavigation(u('/o/r/pull/1'), u('/o/r/pull/1?x=1'))).toBeNull();
  });
});

describe('FeatureHost', () => {
  const recognized = (scope: ScopeId): ScopeDetection => ({ scope, status: 'recognized', variant: 'v', root: document.body, candidates: ['v'] });

  function makeHost(features: FeatureRegistration[], detections: Partial<Record<ScopeId, ScopeDetection>>, over: Partial<ConstructorParameters<typeof FeatureHost>[0]> = {}) {
    const s = session();
    const sink = sinkRecorder();
    const ledger = new MutationLedger();
    const host = new FeatureHost({
      session: s,
      caps: () => createFakeCapabilities(),
      detections: () => detections,
      registrations: features,
      ledger,
      bus: new SessionBus(),
      prefs: prefsStub(),
      messenger: messengerStub,
      observer: new ScopedObserver({ getRoots: () => ({}) }),
      diagnostics: sink,
      ...over,
    });
    return { host, sink, s, ledger };
  }

  it('isolates a throwing mount and still mounts the others', async () => {
    const mounted: string[] = [];
    const { host, sink } = makeHost(
      [
        reg(() => ({ id: 'noiseCollapser', kind: 'mutator', pages: ['issue'], requires: ['timeline'], mount: () => { throw new Error('boom'); } })),
        reg(() => ({ id: 'timelineMarkers', kind: 'mutator', pages: ['issue'], requires: ['timeline'], mount: () => { mounted.push('markers'); } })),
      ],
      { timeline: recognized('timeline') }
    );
    await host.mountReady();
    expect(mounted).toEqual(['markers']);
    expect(host.status().noiseCollapser?.health).toBe('disabled');
    expect(sink.outcomes).toContainEqual(['noiseCollapser', 'disabled']);
    expect(sink.outcomes).toContainEqual(['timelineMarkers', 'ok']);
  });

  it('trips the breaker after repeated callback errors and reverts the feature', async () => {
    document.body.innerHTML = '<div id="x"></div>';
    let fire: () => void = () => {};
    const { host } = makeHost(
      [
        reg(() => ({
          id: 'sidebarWidget',
          kind: 'mutator',
          pages: ['issue'],
          requires: ['sidebar'],
          mount: (ctx) => {
            ctx.ledger.insert(ctx.ledger.create('div'), { appendTo: document.getElementById('x')! });
            fire = ctx.guard(() => {
              throw new Error('cb');
            });
          },
        })),
      ],
      { sidebar: recognized('sidebar') }
    );
    await host.mountReady();
    expect(document.querySelectorAll(`[${OWN_ATTR}]`)).toHaveLength(1);
    fire();
    fire();
    fire();
    expect(host.status().sidebarWidget?.health).toBe('disabled');
    expect(document.querySelectorAll(`[${OWN_ATTR}]`)).toHaveLength(0);
  });

  it('gates mutators on scopes and fails closed after settle', async () => {
    const mounted: string[] = [];
    const detections: Partial<Record<ScopeId, ScopeDetection>> = { timeline: { scope: 'timeline', status: 'unrecognized', candidates: [] } };
    const { host, sink } = makeHost(
      [
        reg(() => ({ id: 'viewTracker', kind: 'observer', pages: ['issue'], requires: [], mount: () => { mounted.push('view'); } })),
        reg(() => ({ id: 'noiseCollapser', kind: 'mutator', pages: ['issue'], requires: ['timeline'], mount: () => { mounted.push('collapser'); } })),
      ],
      detections
    );
    await host.mountReady();
    expect(mounted).toEqual(['view']);
    host.finalizeSettle();
    expect(host.status().noiseCollapser?.health).toBe('unrecognized');
    expect(sink.diags).toContainEqual(['noiseCollapser', 'SCOPE_UNRECOGNIZED']);
    expect(sink.outcomes).toContainEqual(['noiseCollapser', 'unrecognized']);
  });

  it('keeps mutators off in safe mode', async () => {
    const mounted: string[] = [];
    const { host } = makeHost(
      [reg(() => ({ id: 'ackButton', kind: 'mutator', pages: ['issue'], requires: ['composer'], mount: () => { mounted.push('ack'); } }))],
      { composer: recognized('composer') },
      { prefs: prefsStub({ safeMode: true }) }
    );
    await host.mountReady();
    expect(mounted).toEqual([]);
    expect(host.status().ackButton?.health).toBe('off');
  });

  it('marks drift when a fallback is resolved during a mount', async () => {
    const { host, sink } = makeHost(
      [
        reg(() => ({
          id: 'timelineMarkers',
          kind: 'mutator',
          pages: ['issue'],
          requires: ['timeline'],
          mount: () => {
            host.onResolveEvent({ anchor: 'timeline.item', scope: 'timeline', base: null, resolution: { status: 'fallback', els: [], selectorIndex: 1, variant: 'v' } });
          },
        })),
      ],
      { timeline: recognized('timeline') }
    );
    await host.mountReady();
    expect(sink.diags).toContainEqual(['timelineMarkers', 'DOM_ANCHOR_FALLBACK']);
    expect(sink.outcomes.filter(([f]) => f === 'timelineMarkers').map(([, o]) => o)).toEqual(['drifted']);
  });
});

describe('Engine', () => {
  const variant: VariantModule = {
    id: 'v',
    detectors: { sidebar: { variant: 'v', root: { selectors: ['#sidebar'] } } },
    anchors: {},
    adapters: {},
  };

  beforeEach(() => {
    // The engine treats a missing chrome.runtime as an invalidated (orphaned) context.
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test',
        lastError: undefined,
        sendMessage: (_m: unknown, cb: (r: unknown) => void) => cb({ ok: false, error: 'stub' }),
      },
    });
    window.history.replaceState(null, '', '/o/r/issues/1');
    document.body.innerHTML = '<div id="sidebar"><div id="first"></div></div>';
    document.documentElement.removeAttribute(INSTANCE_ATTR);
    document.documentElement.removeAttribute(SAFE_ATTR);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function deps(features: FeatureRegistration[]): EngineDeps {
    return {
      variants: [variant],
      features,
      settleMs: 50,
      computePageFacts: (url) => ({
        facts: fakePageFacts({ item: { owner: 'o', repo: 'r', number: Number(url.pathname.split('/')[4]), itemId: 'x' } }),
        pageDetection: { scope: 'page', status: 'recognized', variant: 'v', root: document.documentElement, candidates: ['v'] },
      }),
      buildCapabilities: () =>
        createFakeCapabilities({ sidebar: createFakeSidebar({ before: document.getElementById('first')! }) }),
    };
  }

  it('leaves exactly one widget after rapid overlapping navigations (no ping-pong)', async () => {
    const widget = (): Feature => ({
      id: 'sidebarWidget',
      kind: 'mutator',
      pages: ['issue'],
      requires: ['sidebar'],
      mount: async (ctx) => {
        await ctx.delay(5); // simulates awaiting preferences / daemon
        const point = ctx.caps.sidebar!.insertionPoint();
        if (point) ctx.ledger.insert(ctx.ledger.create('section', 'w'), point);
      },
    });
    const engine = new Engine(deps([reg(widget)]));
    engine.start();
    for (const n of [2, 3, 4]) {
      window.history.pushState(null, '', `/o/r/issues/${n}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
    await new Promise((r) => setTimeout(r, 40));
    expect(document.querySelectorAll(`[${OWN_ATTR}]`)).toHaveLength(1);
    expect(engine.current?.session.facts.item?.number).toBe(4);
    engine.shutdown();
    expect(document.querySelectorAll(`[${OWN_ATTR}]`)).toHaveLength(0);
  });

  it('shuts down into safe mode when the extension context is invalidated', async () => {
    vi.stubGlobal('chrome', { runtime: {} });
    const engine = new Engine(deps([]));
    engine.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(engine.current).toBeNull();
    expect(document.documentElement.hasAttribute(SAFE_ATTR)).toBe(true);
  });

  it('steps aside when a newer instance takes over', async () => {
    const engine = new Engine(deps([]));
    engine.start();
    expect(engine.current).not.toBeNull();
    document.documentElement.setAttribute(INSTANCE_ATTR, 'newer');
    await new Promise((r) => setTimeout(r, 0));
    expect(engine.current).toBeNull();
  });
});
