import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { create, toJson } from '@bufbuild/protobuf';
import { BadgeCountMode, NotificationSettingsSchema } from '../../api/octodeck/v1/service_pb';
import {
  formToSettings,
  loadSettings,
  readForm,
  saveSettings,
  settingsToForm,
  validateSettingsForm,
  writeForm,
  type SettingsForm,
} from '../options';
import type { ExtensionMessage } from '../types';

const SETTINGS_DOM = `
  <div id="settings-unavailable"></div>
  <fieldset id="badge-settings" disabled>
    <input type="radio" name="badge-mode" id="badge-mode-inbox" />
    <input type="radio" name="badge-mode" id="badge-mode-unread" />
    <input type="radio" name="badge-mode" id="badge-mode-disabled" />
  </fieldset>
  <fieldset id="notification-settings" disabled>
    <input type="checkbox" id="notif-enabled" />
    <div id="filter-options-panel">
      <textarea id="filter-repos"></textarea><div id="filter-repos-error"></div>
      <textarea id="filter-labels"></textarea><div id="filter-labels-error"></div>
      <textarea id="filter-authors"></textarea><div id="filter-authors-error"></div>
      <input type="checkbox" id="notif-mentions" />
      <input type="checkbox" id="notif-assigned" />
      <input type="checkbox" id="notif-ignore-bots" />
      <input type="checkbox" id="notif-new-items" />
      <input type="checkbox" id="notif-activity" />
    </div>
  </fieldset>
  <div id="toast"></div>
`;

function sampleForm(overrides: Partial<SettingsForm> = {}): SettingsForm {
  return {
    enabled: true,
    repos: 'kubernetes/*\n!kubernetes/website',
    labels: 'kind/bug',
    authors: '!dependabot*',
    alwaysIncludeMentions: true,
    onlyAssignedOrAuthored: false,
    ignoreBots: true,
    notifyOnNewItems: false,
    notifyOnNewActivity: true,
    badgeMode: 'unread',
    ...overrides,
  };
}

describe('notification settings form mapping', () => {
  it('round-trips between the form and the settings message', () => {
    const form = sampleForm();
    const settings = formToSettings(form);

    expect(settings.repoIncludes).toEqual(['kubernetes/*']);
    expect(settings.repoExcludes).toEqual(['kubernetes/website']);
    expect(settings.labelIncludes).toEqual(['kind/bug']);
    expect(settings.authorIncludes).toEqual([]);
    expect(settings.authorExcludes).toEqual(['dependabot*']);
    expect(settings.badgeCountMode).toBe(BadgeCountMode.UNREAD);
    expect(settingsToForm(settings)).toEqual(form);
  });

  it('maps every badge mode', () => {
    for (const badgeMode of ['inbox', 'unread', 'disabled'] as const) {
      expect(settingsToForm(formToSettings(sampleForm({ badgeMode }))).badgeMode).toBe(badgeMode);
    }
    expect(settingsToForm(create(NotificationSettingsSchema, {})).badgeMode).toBe('inbox');
  });

  it('reports invalid patterns per field', () => {
    expect(validateSettingsForm(sampleForm())).toEqual({});
    const errors = validateSettingsForm(sampleForm({ repos: 'not-a-repo', labels: '!', authors: 'ok' }));
    expect(errors.repos).toMatch(/owner\/repo/);
    expect(errors.labels).toBeTruthy();
    expect(errors.authors).toBeUndefined();
  });
});

describe('notification settings DOM binding', () => {
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = SETTINGS_DOM;
    sendMessage = vi.fn();
    vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: undefined } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes and reads back the form', () => {
    const form = sampleForm();
    writeForm(form);
    expect(readForm()).toEqual(form);
  });

  it('loads settings from the daemon and enables editing', async () => {
    const settings = formToSettings(sampleForm());
    sendMessage.mockImplementation((msg: ExtensionMessage, cb: (res: unknown) => void) => {
      expect(msg.type).toBe('GET_NOTIFICATION_SETTINGS');
      cb({ ok: true, data: toJson(NotificationSettingsSchema, settings) });
    });

    await expect(loadSettings()).resolves.toBe(true);
    expect(readForm()).toEqual(sampleForm());
    expect((document.getElementById('notification-settings') as HTMLFieldSetElement).disabled).toBe(false);
    expect(document.getElementById('settings-unavailable')?.classList.contains('show')).toBe(false);
  });

  it('keeps settings disabled when the daemon is unreachable', async () => {
    sendMessage.mockImplementation((_msg: ExtensionMessage, cb: (res: unknown) => void) => {
      cb({ ok: false, error: 'offline' });
    });

    await expect(loadSettings()).resolves.toBe(false);
    expect((document.getElementById('badge-settings') as HTMLFieldSetElement).disabled).toBe(true);
    expect(document.getElementById('settings-unavailable')?.classList.contains('show')).toBe(true);
  });

  it('saves valid settings through the background', async () => {
    writeForm(sampleForm());
    sendMessage.mockImplementation((_msg: ExtensionMessage, cb: (res: unknown) => void) => {
      cb({ ok: true, data: {} });
    });

    await expect(saveSettings()).resolves.toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const msg = sendMessage.mock.calls[0][0] as ExtensionMessage;
    expect(msg).toEqual({
      type: 'SAVE_NOTIFICATION_SETTINGS',
      settings: toJson(NotificationSettingsSchema, formToSettings(sampleForm())),
    });
  });

  it('does not save invalid settings and shows the error', async () => {
    writeForm(sampleForm({ repos: 'bad' }));

    await expect(saveSettings()).resolves.toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    const error = document.getElementById('filter-repos-error');
    expect(error?.textContent).toMatch(/owner\/repo/);
    expect(error?.classList.contains('show')).toBe(true);
  });
});
