/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authInterceptor, onAuthError } from '../client';
import { StorageService } from '../../services/storage';
import { ConnectError, Code } from '@connectrpc/connect';
import { DEFAULT_API_BASE_URL } from '../../utils/constants';

describe('client / authInterceptor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('should inject Authorization header if bearer token exists', async () => {
    vi.spyOn(StorageService, 'getBearerToken').mockResolvedValue('test-token');
    const mockReq = {
      header: {
        set: vi.fn(),
      },
    } as any;
    const mockNext = vi.fn().mockResolvedValue('response');

    const invoker = authInterceptor(mockNext);
    const res = await invoker(mockReq);

    expect(mockReq.header.set).toHaveBeenCalledWith('Authorization', 'Bearer test-token');
    expect(mockNext).toHaveBeenCalledWith(mockReq);
    expect(res).toBe('response');
  });

  it('should not inject Authorization header if no bearer token', async () => {
    vi.spyOn(StorageService, 'getBearerToken').mockResolvedValue('');
    const mockReq = {
      header: {
        set: vi.fn(),
      },
    } as any;
    const mockNext = vi.fn().mockResolvedValue('response');

    const invoker = authInterceptor(mockNext);
    await invoker(mockReq);

    expect(mockReq.header.set).not.toHaveBeenCalled();
  });

  it('should trigger UNAUTHENTICATED error on Code.Unauthenticated', async () => {
    vi.spyOn(StorageService, 'getBearerToken').mockResolvedValue('token');
    const mockReq = { header: { set: vi.fn() } } as any;
    const error = new ConnectError('Unauthorized', Code.Unauthenticated);
    const mockNext = vi.fn().mockRejectedValue(error);

    const onAuth = vi.fn();
    onAuthError(onAuth);

    const invoker = authInterceptor(mockNext);
    await expect(invoker(mockReq)).rejects.toBe(error);

    expect(onAuth).toHaveBeenCalledWith('UNAUTHENTICATED', 'Local authentication required');
  });

  it('should trigger UPSTREAM_AUTH_REQUIRED on Code.Internal if status returns it', async () => {
    vi.spyOn(StorageService, 'getBearerToken').mockResolvedValue('token');
    const mockReq = { header: { set: vi.fn() } } as any;
    const error = new ConnectError('Internal', Code.Internal);
    const mockNext = vi.fn().mockRejectedValue(error);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: 'UPSTREAM_AUTH_REQUIRED', message: 'GitHub auth required' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const onAuth = vi.fn();
    onAuthError(onAuth);

    const invoker = authInterceptor(mockNext);
    await expect(invoker(mockReq)).rejects.toBe(error);

    expect(fetchMock).toHaveBeenCalledWith(`${DEFAULT_API_BASE_URL}/status`);
    expect(onAuth).toHaveBeenCalledWith('UPSTREAM_AUTH_REQUIRED', 'GitHub auth required');
  });
});
