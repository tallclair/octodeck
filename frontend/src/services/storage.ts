import type { StorageData } from '../types';

const DEFAULT_SETTINGS: StorageData['settings'] = {};

const DEFAULT_STORAGE: StorageData = {
  settings: DEFAULT_SETTINGS,
};

export class StorageService {
  static async get(): Promise<StorageData> {
    if (!__IS_EXTENSION__) {
      try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('octodeck_storage') : null;
        const result = raw ? JSON.parse(raw) : {};
        return {
          settings: { ...DEFAULT_SETTINGS, ...(result.settings || {}) },
          currentUser: (result.currentUser as StorageData['currentUser']),
        };
      } catch (e) {
        console.warn('localStorage get failed, returning defaults', e);
        return DEFAULT_STORAGE;
      }
    }

    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      // Fallback for testing outside extension context
      console.warn('Chrome storage not available, returning default/mock data');
      return DEFAULT_STORAGE;
    }

    const result = await chrome.storage.local.get(null);
    // Deep merge with defaults to ensure structure exists
    return {
      settings: { ...DEFAULT_SETTINGS, ...(result.settings || {}) },
      currentUser: (result.currentUser as StorageData['currentUser']),
    };
  }

  static async getBearerToken(): Promise<string> {
    const data = await this.get();
    return data.settings.bearer_token || '';
  }

  static async setBearerToken(token: string): Promise<void> {
    const data = await this.get();
    data.settings.bearer_token = token;
    await this.save(data);
  }

  static async getStableExtId(): Promise<string> {
    const data = await this.get();
    return data.settings.stable_ext_id || '';
  }

  static async setStableExtId(id: string): Promise<void> {
    const data = await this.get();
    data.settings.stable_ext_id = id;
    await this.save(data);
  }

  static async save(data: Partial<StorageData>): Promise<void> {
    if (!__IS_EXTENSION__) {
      try {
        if (typeof localStorage !== 'undefined') {
          const current = await this.get();
          const updated = { ...current, ...data };
          localStorage.setItem('octodeck_storage', JSON.stringify(updated));
        }
      } catch (e) {
        console.warn('localStorage save failed', e);
      }
      return;
    }

    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      console.warn('Chrome storage not available, skipping save');
      return;
    }
    await chrome.storage.local.set(data);
  }
}