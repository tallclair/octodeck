import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StorageService } from '../storage';

describe('StorageService', () => {
  const mockGet = vi.fn();
  const mockSet = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: mockGet,
          set: mockSet,
        },
      },
    });
  });

  it('should retrieve currentUser if it exists in storage', async () => {
    const mockData = {
      currentUser: { login: 'testuser', avatarUrl: 'url' },
      settings: { github_pat: 'token' }
    };
    mockGet.mockResolvedValue(mockData);

    const result = await StorageService.get();

    expect(result.currentUser).toEqual(mockData.currentUser);
  });

  it('should return default storage structure if storage is empty', async () => {
    mockGet.mockResolvedValue({});
    const result = await StorageService.get();
    
    expect(result.settings).toEqual({});
  });

  it('should get and set bearer token', async () => {
    mockGet.mockResolvedValue({ settings: { bearer_token: 'test-bearer' } });
    expect(await StorageService.getBearerToken()).toBe('test-bearer');

    mockGet.mockResolvedValue({ settings: {} });
    await StorageService.setBearerToken('new-bearer');
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ bearer_token: 'new-bearer' })
      })
    );
  });

  it('should get and set stable ext id', async () => {
    mockGet.mockResolvedValue({ settings: { stable_ext_id: 'test-id' } });
    expect(await StorageService.getStableExtId()).toBe('test-id');

    mockGet.mockResolvedValue({ settings: {} });
    await StorageService.setStableExtId('new-id');
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ stable_ext_id: 'new-id' })
      })
    );
  });
});