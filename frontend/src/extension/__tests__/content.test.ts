/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initContentScript } from '../content';
import * as viewTrackerModule from '../content/viewTracker';
import * as actionTrackerModule from '../content/actionTracker';

describe('content script initialization', () => {
  let originalLocationHref: string;

  beforeEach(() => {
    originalLocationHref = window.location.href;

    (globalThis as any).chrome = {
      runtime: {
        getManifest: vi.fn(() => ({
          version_name: 'v0.2.0-5-gabcdef-dirty',
          version: '0.2.0',
        })),
        sendMessage: vi.fn(),
      },
      storage: {
        local: {
          get: vi.fn(),
        },
        onChanged: {
          addListener: vi.fn(),
        },
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, 'location', {
      value: { href: originalLocationHref, assign: vi.fn() },
      writable: true,
    });
  });

  it('initializes GitHub view and action tracking', () => {
    const initViewTrackerSpy = vi.spyOn(viewTrackerModule, 'initViewTracker').mockImplementation(() => () => {});
    const initActionTrackerSpy = vi.spyOn(actionTrackerModule, 'initActionTracker').mockImplementation(() => () => {});

    initContentScript();

    expect(initViewTrackerSpy).toHaveBeenCalled();
    expect(initActionTrackerSpy).toHaveBeenCalled();
  });
});

