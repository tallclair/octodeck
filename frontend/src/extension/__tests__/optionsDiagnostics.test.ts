import optionsHtml from '../options.html?raw';
import {
  browserLabel,
  clearDiagnostics,
  copyDiagnosticsReport,
  downloadDiagnosticsReport,
  initSafeMode,
  renderDiagnostics,
} from '../options';
import type { DiagnosticsSnapshot, ExtensionMessage } from '../types';

const snapshot: DiagnosticsSnapshot = {
  extensionVersion: 'v1.2.3',
  stream: { status: 'connected', since: 1 },
  health: [
    {
      feature: 'sidebarWidget',
      variant: 'react',
      state: 'degraded',
      consecutiveFailures: 3,
      failurePaths: ['o/r/issues/1', 'o/r/issues/2'],
      since: Date.UTC(2026, 9, 18),
    },
    { feature: 'noiseCollapser', variant: 'classic', state: 'healthy', consecutiveFailures: 0, failurePaths: [], since: 1 },
  ],
  records: [
    {
      key: 'k1',
      code: 'DOM_ANCHOR_MISSING',
      severity: 'warn',
      feature: 'sidebarWidget',
      features: ['sidebarWidget', 'ackButton'],
      scope: 'sidebar',
      anchor: 'sidebar.insertBefore',
      variant: 'react',
      pageKind: 'issue',
      resolution: 'missing',
      // Page-derived strings must render as text, never as markup.
      fingerprint: 'div[data-testid=issue-viewer-metadata-pane]\n  <img src=x onerror=alert(1)>',
      extVersion: 'v1.2.3',
      firstSeen: 1,
      lastSeen: 2,
      count: 3,
      samplePaths: ['o/r/issues/1'],
      lastContext: { elapsedMs: 8200, visibleAtStart: false, visible: true, focused: true },
    },
  ],
};

function loadOptionsBody(): void {
  const doc = new DOMParser().parseFromString(optionsHtml, 'text/html');
  doc.querySelectorAll('script').forEach((s) => s.remove());
  document.body.innerHTML = doc.body.innerHTML;
}

describe('GitHub compatibility panel', () => {
  let local: Record<string, unknown>;
  let sent: ExtensionMessage[];

  beforeEach(() => {
    loadOptionsBody();
    local = {};
    sent = [];
    vi.stubGlobal('chrome', {
      runtime: {
        lastError: undefined,
        sendMessage: vi.fn((msg: ExtensionMessage, cb: (res: unknown) => void) => {
          sent.push(msg);
          cb(msg.type === 'GET_DIAGNOSTICS' ? { ok: true, data: snapshot } : { ok: true, data: true });
        }),
      },
      storage: {
        local: {
          get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in local).map((k) => [k, local[k]]))),
          set: vi.fn(async (data: Record<string, unknown>) => Object.assign(local, data)),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('renders health and records', () => {
    renderDiagnostics(snapshot);
    expect(document.getElementById('compat-badge')?.textContent).toBe('Limited');
    const rows = Array.from(document.querySelectorAll('#compat-health tbody tr')).map((tr) =>
      Array.from(tr.children).map((td) => td.textContent)
    );
    expect(rows[0].slice(0, 2)).toEqual(['Sidebar widget', 'react']);
    expect(rows[0][2]).toMatch(/^Paused: page layout not recognized/);
    expect(rows[1]).toEqual(['Noise collapsing', 'classic', 'OK']);
    expect(document.getElementById('compat-empty')?.style.display).toBe('none');

    const record = document.querySelector('#compat-records details')!;
    expect(record.querySelector('summary')?.textContent).toBe(
      'Sidebar widget, Ack button: DOM_ANCHOR_MISSING (sidebar / sidebar.insertBefore), 3×'
    );
    expect(record.textContent).toContain('Last seen 8.2 s after navigation; tab visible and focused (hidden at start).');
    expect(record.textContent).toContain('Pages: o/r/issues/1');
    expect(record.querySelector('img')).toBeNull();
    expect(record.querySelector('pre')?.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('shows an empty state', () => {
    renderDiagnostics({ ...snapshot, health: [], records: [] });
    expect(document.getElementById('compat-badge')?.textContent).toBe('No data yet');
    expect(document.getElementById('compat-health')?.style.display).toBe('none');
    expect(document.getElementById('compat-empty')?.style.display).toBe('');
  });

  it('copies a Markdown report including page links', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText }, userAgent: 'Mozilla/5.0 Chrome/131.0.0.0' });
    renderDiagnostics(snapshot);
    expect(await copyDiagnosticsReport()).toBe(true);
    const md = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(md).toContain('| Extension | v1.2.3 |');
    expect(md).toContain('- https://github.com/o/r/issues/1');
  });

  it('downloads a JSON export', async () => {
    const createObjectURL = vi.fn((blob: Blob) => {
      void blob;
      return 'blob:x';
    });
    const revokeObjectURL = vi.fn();
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      renderDiagnostics(snapshot);
      await downloadDiagnosticsReport();
      expect(click).toHaveBeenCalled();
      const blob = createObjectURL.mock.calls[0][0];
      const text = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.readAsText(blob);
      });
      expect(JSON.parse(text).records[0].samplePaths).toEqual(['o/r/issues/1']);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:x');
    } finally {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
      click.mockRestore();
    }
  });

  it('clears via the background and reloads', async () => {
    await clearDiagnostics();
    expect(sent.map((m) => m.type)).toEqual(['CLEAR_DIAGNOSTICS', 'GET_DIAGNOSTICS']);
  });

  it('reads and writes the Safe mode switch', async () => {
    local.safe_mode = true;
    await initSafeMode();
    const checkbox = document.getElementById('safe-mode') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(local.safe_mode).toBe(false));
  });
});

describe('browserLabel', () => {
  it('prefers client hints, then the user agent', () => {
    expect(
      browserLabel({
        userAgent: '',
        userAgentData: { brands: [{ brand: 'Not_A Brand', version: '8' }, { brand: 'Chromium', version: '131' }] },
      } as unknown as Navigator)
    ).toBe('Chromium 131');
    expect(browserLabel({ userAgent: 'Mozilla/5.0 Chrome/120.0.1 Safari/537.36' } as Navigator)).toBe('Chrome 120');
  });
});
