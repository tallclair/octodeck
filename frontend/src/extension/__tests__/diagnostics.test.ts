import {
  DEGRADED_MIN_FAILURES,
  MAX_INFO_RECORDS,
  MAX_RECORDS,
  MAX_SAMPLE_PATHS,
  RECORD_TTL_MS,
  applyOutcome,
  buildDiagnosticsExport,
  createDiagnosticsStore,
  formatDiagnosticsMarkdown,
  parseFeatureReport,
  pruneRecords,
  recordKey,
  stableHash,
  upsertRecords,
  type DiagnosticsStorage,
} from '../background/diagnostics';
import type { Diagnostic, DriftRecord, FeatureReport } from '../types';

const URL_A = 'https://github.com/o/r/pull/1';

function report(over: Partial<FeatureReport> = {}): FeatureReport {
  return {
    navId: 'nav-00000001',
    feature: 'sidebarWidget',
    outcome: 'ok',
    pageKind: 'pr-conversation',
    variant: 'classic',
    path: 'o/r/pull/1',
    diagnostics: [],
    ...over,
  };
}

const missing: Diagnostic = {
  code: 'DOM_ANCHOR_MISSING',
  severity: 'warn',
  scope: 'sidebar',
  anchor: 'sidebar.insertBefore',
  fingerprint: 'div#partial-discussion-sidebar\n  div.x',
};

function memoryArea() {
  let store: Record<string, unknown> = {};
  return {
    dump: () => store,
    area: {
      get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]))),
      set: vi.fn(async (data: Record<string, unknown>) => {
        store = { ...store, ...structuredClone(data) };
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
      }),
    },
  };
}

describe('parseFeatureReport', () => {
  it('accepts a valid report', () => {
    const r = report({ diagnostics: [missing], ghRelease: '37d31cd0e04ba0e5736f33e2aaec0c9c84edc184' });
    expect(parseFeatureReport(r, URL_A)).toEqual(r);
  });

  it.each([
    ['unknown feature', { feature: 'evil' }],
    ['unknown outcome', { outcome: 'great' }],
    ['bad navId', { navId: 'x' }],
    ['bad variant', { variant: 'Classic Variant!' }],
    ['bad path', { path: '../../etc' }],
    ['bad release', { ghRelease: 'not-a-sha' }],
    ['too many diagnostics', { diagnostics: Array(11).fill({ code: 'FEATURE_EXCEPTION', severity: 'warn' }) }],
    ['unknown code', { diagnostics: [{ code: 'NOPE', severity: 'warn' }] }],
    ['unknown anchor', { diagnostics: [{ code: 'DOM_ANCHOR_MISSING', severity: 'warn', anchor: 'body' }] }],
    ['negative index', { diagnostics: [{ code: 'DOM_ANCHOR_FALLBACK', severity: 'info', selectorIndex: -1 }] }],
  ])('rejects %s', (_name, over) => {
    expect(parseFeatureReport({ ...report(), ...over }, URL_A)).toBeNull();
  });

  it('rejects non-objects', () => {
    expect(parseFeatureReport(null, URL_A)).toBeNull();
    expect(parseFeatureReport('x', URL_A)).toBeNull();
  });

  it('drops an invalid fingerprint but keeps the diagnostic, and bounds messages', () => {
    const parsed = parseFeatureReport(
      report({ diagnostics: [{ ...missing, fingerprint: '<script>', message: 'm'.repeat(500) }] }),
      URL_A
    );
    expect(parsed?.diagnostics[0].fingerprint).toBeUndefined();
    expect(parsed?.diagnostics[0].message).toHaveLength(200);
  });

  it('clears a path that does not belong to the sending tab', () => {
    expect(parseFeatureReport(report(), 'https://github.com/o/r/pull/2')?.path).toBe('');
    expect(parseFeatureReport(report(), 'https://github.com/o/r/pull/1/files')?.path).toBe('o/r/pull/1');
    expect(parseFeatureReport(report(), undefined)?.path).toBe('');
  });
});

describe('applyOutcome (degraded rule)', () => {
  const fail = (path: string) => report({ outcome: 'unrecognized', path, diagnostics: [missing] });

  it(`degrades after ${DEGRADED_MIN_FAILURES} failures on at least two pages`, () => {
    let h = applyOutcome(undefined, fail('o/r/pull/1'), undefined, 1);
    h = applyOutcome(h, fail('o/r/pull/1'), undefined, 2);
    h = applyOutcome(h, fail('o/r/pull/1'), undefined, 3);
    expect(h?.state).toBe('healthy'); // one page only
    h = applyOutcome(h, fail('o/r/pull/2'), undefined, 4);
    expect(h).toMatchObject({ state: 'degraded', since: 4, consecutiveFailures: 4, lastFailureCodes: ['DOM_ANCHOR_MISSING'] });
    expect(h?.failurePaths).toEqual(['o/r/pull/1', 'o/r/pull/2']);
  });

  it('recovers on ok or drifted and resets the streak', () => {
    let h = applyOutcome(undefined, fail('o/r/pull/1'), undefined, 1);
    h = applyOutcome(h, fail('o/r/pull/2'), undefined, 2);
    h = applyOutcome(h, fail('o/r/pull/3'), undefined, 3);
    expect(h?.state).toBe('degraded');
    h = applyOutcome(h, report({ outcome: 'drifted' }), undefined, 9);
    expect(h).toMatchObject({ state: 'healthy', since: 9, consecutiveFailures: 0, failurePaths: [], lastOkAt: 9 });
  });

  it('ignores notApplicable', () => {
    expect(applyOutcome(undefined, report({ outcome: 'notApplicable' }), undefined, 1)).toBeUndefined();
  });

  it('counts a session at most once as a failure, and a failed session does not un-fail', () => {
    let h = applyOutcome(undefined, report({ outcome: 'ok' }), undefined, 1);
    h = applyOutcome(h, report({ outcome: 'disabled' }), 'ok', 2); // breaker trip after ok
    expect(h?.consecutiveFailures).toBe(1);
    const again = applyOutcome(h, report({ outcome: 'unrecognized' }), 'disabled', 3);
    expect(again).toBe(h);
    expect(applyOutcome(h, report({ outcome: 'ok' }), 'disabled', 4)).toBe(h);
  });
});

describe('drift records', () => {
  it('upserts by key, counting repeats and keeping sample paths', () => {
    let records = upsertRecords([], report({ outcome: 'unrecognized', diagnostics: [missing], ghRelease: 'aaaaaaa' }), 'v1', 1);
    records = upsertRecords(records, report({ outcome: 'unrecognized', diagnostics: [missing], path: 'o/r/pull/2', ghRelease: 'bbbbbbb' }), 'v1', 2);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      code: 'DOM_ANCHOR_MISSING',
      feature: 'sidebarWidget',
      scope: 'sidebar',
      anchor: 'sidebar.insertBefore',
      resolution: 'missing',
      count: 2,
      firstSeen: 1,
      lastSeen: 2,
      ghReleaseFirst: 'aaaaaaa',
      ghReleaseLast: 'bbbbbbb',
      extVersion: 'v1',
      samplePaths: ['o/r/pull/1', 'o/r/pull/2'],
      fingerprint: missing.fingerprint,
    });
  });

  it('keys separately per extension version, variant, resolution and fingerprint', () => {
    const r = report({ diagnostics: [missing] });
    const base = recordKey(r, missing, 'v1');
    expect(recordKey(r, missing, 'v2')).not.toBe(base);
    expect(recordKey({ ...r, variant: 'react' }, missing, 'v1')).not.toBe(base);
    expect(recordKey(r, { ...missing, fingerprint: 'div' }, 'v1')).not.toBe(base);
    expect(recordKey(r, { ...missing, code: 'DOM_ANCHOR_FALLBACK', selectorIndex: 1 }, 'v1')).not.toBe(base);
  });

  it('does not record content-level codes as drift', () => {
    const records = upsertRecords([], report({ diagnostics: [{ code: 'ANCHOR_NOT_FOUND', severity: 'info' }] }), 'v1', 1);
    expect(records).toEqual([]);
  });

  it('caps sample paths', () => {
    let records: DriftRecord[] = [];
    for (let i = 0; i < 10; i++) records = upsertRecords(records, report({ diagnostics: [missing], path: `o/r/pull/${i}` }), 'v1', i);
    expect(records[0].samplePaths).toHaveLength(MAX_SAMPLE_PATHS);
    expect(records[0].samplePaths.at(-1)).toBe('o/r/pull/9');
  });

  it('applies TTL, the info sub-cap and the overall cap', () => {
    const mk = (i: number, severity: 'info' | 'warn', lastSeen: number): DriftRecord => ({
      key: `k${severity}${i}`,
      code: severity === 'info' ? 'DOM_ANCHOR_FALLBACK' : 'DOM_ANCHOR_MISSING',
      severity,
      feature: 'sidebarWidget',
      variant: 'classic',
      pageKind: 'issue',
      resolution: 'missing',
      extVersion: 'v1',
      firstSeen: lastSeen,
      lastSeen,
      count: 1,
      samplePaths: [],
    });
    const now = RECORD_TTL_MS * 2;
    const records = [
      mk(0, 'warn', 0), // expired
      ...Array.from({ length: 60 }, (_, i) => mk(i, 'info', now - 1000 + i)),
      ...Array.from({ length: 80 }, (_, i) => mk(i, 'warn', now - 2000 + i)),
    ];
    const pruned = pruneRecords(records, now);
    expect(pruned).toHaveLength(MAX_RECORDS);
    expect(pruned.filter((r) => r.severity === 'info').length).toBeLessThanOrEqual(MAX_INFO_RECORDS);
    expect(pruned.some((r) => r.key === 'kwarn0' && r.lastSeen === 0)).toBe(false);
    // Newest are kept.
    expect(pruned.at(-1)?.key).toBe('kinfo59');
  });

  it('hashes deterministically', () => {
    expect(stableHash('abc')).toBe(stableHash('abc'));
    expect(stableHash('abc')).not.toBe(stableHash('abd'));
    expect(stableHash('abc')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('createDiagnosticsStore', () => {
  let local: ReturnType<typeof memoryArea>;
  let session: ReturnType<typeof memoryArea>;
  let storage: DiagnosticsStorage;
  let t: number;

  beforeEach(() => {
    local = memoryArea();
    session = memoryArea();
    storage = { local: local.area as never, session: session.area as never };
    t = 1000;
  });

  const store = () => createDiagnosticsStore(storage, 'v1.2.3', () => t++);

  it('reports degraded transitions and records drift', async () => {
    const s = store();
    const fail = (n: number) => report({ navId: `nav-0000000${n}`, outcome: 'unrecognized', path: `o/r/pull/${n}`, diagnostics: [missing] });
    expect((await s.ingest(fail(1))).degradedChanged).toBe(false);
    await s.ingest(fail(2));
    const third = await s.ingest(fail(3));
    expect(third).toEqual({ degraded: ['Sidebar widget'], degradedChanged: true });
    expect(await s.degradedLabels()).toEqual(['Sidebar widget']);

    const recovered = await s.ingest(report({ navId: 'nav-00000004', outcome: 'ok' }));
    expect(recovered).toEqual({ degraded: [], degradedChanged: true });

    const snap = await s.snapshot({ status: 'connected', since: 5 });
    expect(snap.extensionVersion).toBe('v1.2.3');
    expect(snap.health).toHaveLength(1);
    expect(snap.records).toHaveLength(1);
    expect(snap.records[0].count).toBe(3);
  });

  it('keeps variants independent', async () => {
    const s = store();
    for (let n = 1; n <= 3; n++) {
      await s.ingest(report({ navId: `nav-r000000${n}`, variant: 'react', outcome: 'unrecognized', path: `o/r/issues/${n}` }));
      await s.ingest(report({ navId: `nav-c000000${n}`, variant: 'classic', outcome: 'ok' }));
    }
    const snap = await s.snapshot(null);
    expect(snap.health.map((h) => [h.variant, h.state])).toEqual([
      ['classic', 'healthy'],
      ['react', 'degraded'],
    ]);
  });

  it('does not double count a resent report', async () => {
    const s = store();
    const r = report({ outcome: 'unrecognized', path: 'o/r/pull/1' });
    await s.ingest(r);
    await s.ingest(r);
    const snap = await s.snapshot(null);
    expect(snap.health[0].consecutiveFailures).toBe(1);
  });

  it('serializes concurrent reports from several tabs', async () => {
    const s = store();
    await Promise.all(
      Array.from({ length: 5 }, (_, n) =>
        s.ingest(report({ navId: `nav-p000000${n}`, outcome: 'unrecognized', path: `o/r/pull/${n}`, diagnostics: [missing] }))
      )
    );
    const snap = await s.snapshot(null);
    expect(snap.health[0].consecutiveFailures).toBe(5);
    expect(snap.records[0].count).toBe(5);
  });

  it('never stores paths outside records and session health', async () => {
    const s = store();
    await s.ingest(report({ outcome: 'unrecognized', path: 'secret-org/secret-repo/pull/7', diagnostics: [missing] }));
    const localJson = JSON.stringify(local.dump());
    // Records may keep sample paths (decision 10); nothing else in local storage does.
    const { diag_records } = local.dump() as { diag_records: { records: DriftRecord[] } };
    expect(diag_records.records[0].samplePaths).toEqual(['secret-org/secret-repo/pull/7']);
    expect(localJson.split('secret-repo').length - 1).toBe(1);
  });

  it('clears everything', async () => {
    const s = store();
    await s.ingest(report({ outcome: 'unrecognized', diagnostics: [missing] }));
    await s.clear();
    const snap = await s.snapshot(null);
    expect(snap.health).toEqual([]);
    expect(snap.records).toEqual([]);
  });

  it('ignores stored data from another schema', async () => {
    await local.area.set({ diag_records: { schema: 999, records: [{ bogus: true }] } });
    const snap = await store().snapshot(null);
    expect(snap.records).toEqual([]);
  });
});

describe('exports', () => {
  const env = { browser: 'Chrome 131', generatedAt: Date.UTC(2026, 9, 18) };

  it('builds Markdown with environment, health, records, page links and fingerprints', async () => {
    const records = upsertRecords([], report({ outcome: 'unrecognized', diagnostics: [missing], ghRelease: '37d31cd' }), 'v1', Date.UTC(2026, 9, 17));
    const md = formatDiagnosticsMarkdown(
      {
        extensionVersion: 'v1',
        stream: null,
        health: [applyOutcome(undefined, report({ outcome: 'unrecognized', diagnostics: [missing] }), undefined, Date.UTC(2026, 9, 17))!],
        records,
      },
      env
    );
    expect(md).toContain('| Extension | v1 |');
    expect(md).toContain('| GitHub release(s) | 37d31cd |');
    expect(md).toContain('| Sidebar widget | classic | healthy | 1 |');
    expect(md).toContain('| DOM_ANCHOR_MISSING | Sidebar widget | sidebar / sidebar.insertBefore | classic | pr-conversation | missing | 1 |');
    expect(md).toContain('- https://github.com/o/r/pull/1');
    expect(md).toContain('```\ndiv#partial-discussion-sidebar\n  div.x\n```');
  });

  it('says so when there is nothing to report', () => {
    const md = formatDiagnosticsMarkdown({ extensionVersion: 'v1', stream: null, health: [], records: [] }, env);
    expect(md).toContain('No reports yet.');
    expect(md.endsWith('None.')).toBe(true);
  });

  it('builds the JSON export', () => {
    const records = upsertRecords([], report({ diagnostics: [missing], ghRelease: 'abcdef1' }), 'v1', 1);
    const json = buildDiagnosticsExport({ extensionVersion: 'v1', stream: null, health: [], records }, env);
    expect(json).toMatchObject({
      schema: 1,
      generatedAt: '2026-10-18T00:00:00.000Z',
      environment: { extensionVersion: 'v1', browser: 'Chrome 131', githubReleases: ['abcdef1'] },
      records,
    });
  });
});
