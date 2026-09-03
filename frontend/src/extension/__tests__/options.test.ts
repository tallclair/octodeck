/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getExtensionVersion, updateDaemonUI } from '../options';
import type { DaemonStatus } from '../types';

describe('Extension Options UI & Daemon Version Surfacing', () => {
  function setupDOM() {
    document.body.innerHTML = `
      <div class="card">
        <div class="card-title">
          <span>Daemon Connection</span>
          <span id="daemon-badge" class="status-badge status-offline">Connecting...</span>
        </div>
        <div id="daemon-info" class="form-desc">Checking local daemon on 127.0.0.1:38274...</div>

        <div class="version-row">
          <div>
            <span class="version-label">Extension Version:</span>
            <code id="extension-version" class="version-val">Loading...</code>
          </div>
          <div>
            <span class="version-label">Daemon Version:</span>
            <code id="daemon-version" class="version-val">Loading...</code>
          </div>
        </div>

        <div id="version-mismatch-warning" class="version-mismatch-banner" style="display: none;">
          <div class="version-mismatch-content">
            <span>⚠️</span>
            <div>
              <span class="version-mismatch-title">Version Mismatch Warning:</span>
              Extension (<span id="warn-ext-version"></span>) and daemon (<span id="warn-daemon-version"></span>) versions differ. Please reload or update the extension.
            </div>
          </div>
        </div>
      </div>
    `;
  }

  beforeEach(() => {
    setupDOM();
    (globalThis as any).chrome = {
      runtime: {
        getManifest: vi.fn(() => ({
          version: '0.2.0',
          version_name: 'v0.2.0-1-gabcdef',
        })),
        sendMessage: vi.fn(),
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  describe('getExtensionVersion()', () => {
    it('returns version_name from chrome.runtime.getManifest when present', () => {
      expect(getExtensionVersion()).toBe('v0.2.0-1-gabcdef');
    });

    it('falls back to numeric version when version_name is absent', () => {
      (globalThis as any).chrome.runtime.getManifest.mockReturnValue({
        version: '0.2.0',
      });
      expect(getExtensionVersion()).toBe('0.2.0');
    });

    it('falls back to __APP_VERSION__ when chrome runtime manifest is unavailable', () => {
      (globalThis as any).chrome = undefined;
      expect(getExtensionVersion()).toBe(__APP_VERSION__);
    });

    it('handles exceptions thrown by chrome.runtime.getManifest safely', () => {
      (globalThis as any).chrome = {
        runtime: {
          getManifest: () => {
            throw new Error('extension context invalidated');
          },
        },
      };
      expect(getExtensionVersion()).toBe(__APP_VERSION__);
    });
  });

  describe('updateDaemonUI() - Matching State', () => {
    it('renders matching version and hides mismatch warning banner', () => {
      const status: DaemonStatus = {
        online: true,
        version: 'v0.2.0-1-gabcdef',
        ghAuthenticated: true,
      };

      updateDaemonUI(status);

      const extEl = document.getElementById('extension-version');
      const daemonEl = document.getElementById('daemon-version');
      const badge = document.getElementById('daemon-badge');
      const info = document.getElementById('daemon-info');
      const mismatch = document.getElementById('version-mismatch-warning');

      expect(extEl?.textContent).toBe('v0.2.0-1-gabcdef');
      expect(daemonEl?.textContent).toBe('v0.2.0-1-gabcdef');
      expect(badge?.className).toBe('status-badge status-online');
      expect(badge?.textContent).toBe('Online (vv0.2.0-1-gabcdef)');
      expect(info?.textContent).toBe('Connected to local daemon. GitHub authenticated.');
      expect(mismatch?.style.display).toBe('none');
    });

    it('correctly handles unauthenticated online daemon', () => {
      const status: DaemonStatus = {
        online: true,
        version: 'v0.2.0-1-gabcdef',
        ghAuthenticated: false,
      };

      updateDaemonUI(status);

      const info = document.getElementById('daemon-info');
      expect(info?.textContent).toBe(
        'Connected to local daemon. Upstream GitHub authentication required.'
      );
      expect(document.getElementById('version-mismatch-warning')?.style.display).toBe('none');
    });
  });

  describe('updateDaemonUI() - Mismatching State', () => {
    it('displays mismatch warning banner with both version strings when versions differ', () => {
      const status: DaemonStatus = {
        online: true,
        version: 'v0.3.0',
        ghAuthenticated: true,
      };

      updateDaemonUI(status);

      const extEl = document.getElementById('extension-version');
      const daemonEl = document.getElementById('daemon-version');
      const mismatch = document.getElementById('version-mismatch-warning');
      const warnExt = document.getElementById('warn-ext-version');
      const warnDaemon = document.getElementById('warn-daemon-version');

      expect(extEl?.textContent).toBe('v0.2.0-1-gabcdef');
      expect(daemonEl?.textContent).toBe('v0.3.0');
      expect(mismatch?.style.display).toBe('block');
      expect(warnExt?.textContent).toBe('v0.2.0-1-gabcdef');
      expect(warnDaemon?.textContent).toBe('v0.3.0');
    });

    it('hides warning banner when switching from mismatch to matching versions', () => {
      // First trigger mismatch
      updateDaemonUI({
        online: true,
        version: 'v0.3.0',
        ghAuthenticated: true,
      });
      const mismatch = document.getElementById('version-mismatch-warning');
      expect(mismatch?.style.display).toBe('block');

      // Then update with matching version
      updateDaemonUI({
        online: true,
        version: 'v0.2.0-1-gabcdef',
        ghAuthenticated: true,
      });
      expect(mismatch?.style.display).toBe('none');
    });
  });

  describe('updateDaemonUI() - Offline State', () => {
    it('renders Offline badge, Unavailable daemon version, and hides mismatch warning', () => {
      const status: DaemonStatus = {
        online: false,
        error: 'Connection refused',
      };

      updateDaemonUI(status);

      const extEl = document.getElementById('extension-version');
      const daemonEl = document.getElementById('daemon-version');
      const badge = document.getElementById('daemon-badge');
      const info = document.getElementById('daemon-info');
      const mismatch = document.getElementById('version-mismatch-warning');

      expect(extEl?.textContent).toBe('v0.2.0-1-gabcdef');
      expect(daemonEl?.textContent).toBe('Unavailable');
      expect(badge?.className).toBe('status-badge status-offline');
      expect(badge?.textContent).toBe('Offline');
      expect(info?.textContent).toContain('Unable to connect to local OctoDeck daemon: Connection refused');
      expect(mismatch?.style.display).toBe('none');
    });

    it('hides warning banner when transitioning from mismatch to offline', () => {
      // First trigger mismatch
      updateDaemonUI({
        online: true,
        version: 'v0.3.0',
        ghAuthenticated: true,
      });
      const mismatch = document.getElementById('version-mismatch-warning');
      expect(mismatch?.style.display).toBe('block');

      // Then go offline
      updateDaemonUI({
        online: false,
        error: 'Daemon stopped',
      });
      expect(mismatch?.style.display).toBe('none');
      expect(document.getElementById('daemon-version')?.textContent).toBe('Unavailable');
    });
  });

  describe('updateDaemonUI() - Edge cases and robustness', () => {
    it('does not throw when DOM elements are completely missing', () => {
      document.body.innerHTML = '';
      expect(() => {
        updateDaemonUI({ online: true, version: 'v0.3.0' });
      }).not.toThrow();
      expect(() => {
        updateDaemonUI({ online: false });
      }).not.toThrow();
    });

    it('handles online status with undefined version string gracefully', () => {
      updateDaemonUI({ online: true, version: undefined });
      const daemonEl = document.getElementById('daemon-version');
      expect(daemonEl?.textContent).toBe('unknown');
      expect(document.getElementById('version-mismatch-warning')?.style.display).toBe('none');
    });
  });
});
