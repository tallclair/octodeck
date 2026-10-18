import {
  REPORT_BATCH_MS,
  createDiagnosticsClient,
  reportPath,
  scrubMessage,
  type DiagnosticsClient,
} from '../content/engine/diagnosticsClient';
import type { ExtensionMessage, FeatureReport } from '../types';

describe('diagnosticsClient', () => {
  let sent: FeatureReport[];
  let client: DiagnosticsClient;

  const session = { navId: 'nav-1', pageKind: 'issue' as const, path: 'o/r/issues/1', ghRelease: 'abc1234' };

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    client = createDiagnosticsClient({
      send: async (msg: ExtensionMessage) => {
        if (msg.type === 'REPORT_DIAGNOSTIC') sent.push(msg.report);
        return { ok: true, data: true };
      },
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h),
    });
    client.beginSession(session);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends one report per feature after the batching window, with diagnostics from the settle window', () => {
    client.add('sidebarWidget', { code: 'DOM_ANCHOR_FALLBACK', severity: 'info', anchor: 'sidebar.root', selectorIndex: 1 });
    client.setOutcome('sidebarWidget', 'drifted', 'react');
    client.add('sidebarWidget', { code: 'DOM_ANCHOR_FALLBACK', severity: 'info', anchor: 'sidebar.insertBefore', selectorIndex: 2 });
    expect(sent).toHaveLength(0);

    vi.advanceTimersByTime(REPORT_BATCH_MS);
    expect(sent).toEqual([
      {
        navId: 'nav-1',
        feature: 'sidebarWidget',
        outcome: 'drifted',
        pageKind: 'issue',
        variant: 'react',
        path: 'o/r/issues/1',
        ghRelease: 'abc1234',
        diagnostics: [
          { code: 'DOM_ANCHOR_FALLBACK', severity: 'info', anchor: 'sidebar.root', selectorIndex: 1 },
          { code: 'DOM_ANCHOR_FALLBACK', severity: 'info', anchor: 'sidebar.insertBefore', selectorIndex: 2 },
        ],
      },
    ]);
  });

  it('sends ok reports with no diagnostics', () => {
    client.setOutcome('timelineMarkers', 'ok', 'classic');
    vi.advanceTimersByTime(REPORT_BATCH_MS);
    expect(sent).toMatchObject([{ feature: 'timelineMarkers', outcome: 'ok', diagnostics: [] }]);
  });

  it('deduplicates diagnostics per session by code, scope and anchor', () => {
    client.setOutcome('noiseCollapser', 'unrecognized', 'unknown');
    for (let i = 0; i < 3; i++) client.add('noiseCollapser', { code: 'SCOPE_UNRECOGNIZED', severity: 'warn', scope: 'timeline' });
    vi.advanceTimersByTime(REPORT_BATCH_MS);
    expect(sent[0].diagnostics).toHaveLength(1);

    client.beginSession({ ...session, navId: 'nav-2' });
    client.setOutcome('noiseCollapser', 'unrecognized', 'unknown');
    client.add('noiseCollapser', { code: 'SCOPE_UNRECOGNIZED', severity: 'warn', scope: 'timeline' });
    vi.advanceTimersByTime(REPORT_BATCH_MS);
    expect(sent.map((r) => [r.navId, r.diagnostics.length])).toEqual([
      ['nav-1', 1],
      ['nav-2', 1],
    ]);
  });

  it('sends later errors and outcome changes immediately as follow-ups with the same navId', () => {
    client.setOutcome('ackButton', 'ok', 'classic');
    vi.advanceTimersByTime(REPORT_BATCH_MS);
    client.add('ackButton', { code: 'FEATURE_EXCEPTION', severity: 'error', message: 'boom' });
    vi.advanceTimersByTime(0);
    client.setOutcome('ackButton', 'disabled', 'classic');
    client.add('ackButton', { code: 'FEATURE_DISABLED', severity: 'error' });
    vi.advanceTimersByTime(0);
    expect(sent.map((r) => [r.navId, r.outcome, r.diagnostics.map((d) => d.code)])).toEqual([
      ['nav-1', 'ok', []],
      ['nav-1', 'ok', ['FEATURE_EXCEPTION']],
      ['nav-1', 'disabled', ['FEATURE_DISABLED']],
    ]);
  });

  it('does not resend an unchanged outcome', () => {
    client.setOutcome('expandAll', 'notApplicable', 'react');
    vi.advanceTimersByTime(REPORT_BATCH_MS);
    client.setOutcome('expandAll', 'notApplicable', 'react');
    vi.advanceTimersByTime(REPORT_BATCH_MS);
    expect(sent).toHaveLength(1);
  });

  it('splits more than 10 diagnostics across reports', () => {
    client.setOutcome('noiseCollapser', 'drifted', 'classic');
    const anchors = ['timeline.root', 'timeline.item', 'timeline.row', 'timeline.itemBody', 'timeline.itemAuthor', 'timeline.itemTime'] as const;
    for (const anchor of anchors) {
      client.add('noiseCollapser', { code: 'DOM_ANCHOR_FALLBACK', severity: 'info', anchor });
      client.add('noiseCollapser', { code: 'DOM_ANCHOR_AMBIGUOUS', severity: 'warn', anchor });
    }
    vi.advanceTimersByTime(REPORT_BATCH_MS);
    vi.runOnlyPendingTimers(); // the overflow follow-up
    expect(sent.map((r) => r.diagnostics.length)).toEqual([10, 2]);
  });

  it('drops pending reports when the session ends and ignores calls without a session', () => {
    client.setOutcome('sidebarWidget', 'ok', 'react');
    client.endSession();
    vi.advanceTimersByTime(REPORT_BATCH_MS);
    client.add('sidebarWidget', { code: 'FEATURE_EXCEPTION', severity: 'error' });
    client.setOutcome('sidebarWidget', 'disabled', 'react');
    vi.advanceTimersByTime(REPORT_BATCH_MS);
    expect(sent).toHaveLength(0);
  });

  it('scrubs exception messages', () => {
    client.setOutcome('anchorNav', 'ok', 'classic');
    client.add('anchorNav', {
      code: 'FEATURE_EXCEPTION',
      severity: 'warn',
      message: `failed for https://github.com/acme/secret/pull/1 (acme/secret#1) ${'x'.repeat(300)}`,
    });
    vi.advanceTimersByTime(REPORT_BATCH_MS);
    const message = sent[0].diagnostics[0].message!;
    expect(message).toMatch(/^failed for <url> \(<item>\) x+$/);
    expect(message.length).toBe(200);
  });

  it('survives a rejecting send', async () => {
    const failing = createDiagnosticsClient({
      send: () => Promise.reject(new Error('Extension context invalidated')),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h),
    });
    failing.beginSession(session);
    failing.setOutcome('viewTracker', 'ok', 'react');
    expect(() => vi.advanceTimersByTime(REPORT_BATCH_MS)).not.toThrow();
    await Promise.resolve();
  });
});

describe('reportPath / scrubMessage', () => {
  it('builds paths per page kind', () => {
    expect(reportPath({ owner: 'kubernetes', repo: 'kubernetes', number: 1 }, 'issue')).toBe('kubernetes/kubernetes/issues/1');
    expect(reportPath({ owner: 'o', repo: 'r', number: 2 }, 'pr-subtab')).toBe('o/r/pull/2');
    expect(reportPath(null, 'other')).toBe('');
  });

  it('leaves plain messages alone', () => {
    expect(scrubMessage("Cannot read properties of null (reading 'parentElement')")).toBe(
      "Cannot read properties of null (reading 'parentElement')"
    );
  });
});
