import { createClient, type Interceptor, ConnectError, Code } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { OctoDeckService } from './octodeck/v1/service_pb';
import { StorageService } from '../services/storage';
import { DEFAULT_API_BASE_URL } from '../utils/constants';

export interface StatusResponse {
  gh_authenticated: boolean;
  version: string;
  error?: string;
  message?: string;
  local_auth_error?: string;
}

const BASE_URL = typeof __IS_EXTENSION__ !== 'undefined' && __IS_EXTENSION__ 
  ? DEFAULT_API_BASE_URL 
  : '/api/v1';

type AuthErrorType = 'UNAUTHENTICATED' | 'UPSTREAM_AUTH_REQUIRED';
type AuthErrorHandler = (error: AuthErrorType, message?: string) => void;
const authErrorHandlers: AuthErrorHandler[] = [];

export const onAuthError = (handler: AuthErrorHandler) => {
  authErrorHandlers.push(handler);
  return () => {
    const index = authErrorHandlers.indexOf(handler);
    if (index !== -1) authErrorHandlers.splice(index, 1);
  };
};

const triggerAuthError = (error: AuthErrorType, message?: string) => {
  authErrorHandlers.forEach((h) => h(error, message));
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('octodeck:auth-error', {
        detail: { error, message },
      })
    );
  }
};

export async function checkStatus(): Promise<StatusResponse> {
  const res = await fetch(`${BASE_URL}/status`);
  if (!res.ok) {
    throw new Error(`Status check failed with HTTP ${res.status}`);
  }
  return (await res.json()) as StatusResponse;
}

function getCSRFCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/(?:^|;\s*)octodeck_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export const authInterceptor: Interceptor = (next) => async (req) => {
  if (typeof __IS_EXTENSION__ !== 'undefined' && __IS_EXTENSION__) {
    const token = await StorageService.getBearerToken();
    if (token) {
      req.header.set('Authorization', `Bearer ${token}`);
    }
  } else {
    const csrfToken = getCSRFCookie();
    if (csrfToken) {
      req.header.set('X-Csrf-Token', csrfToken);
    }
  }

  try {
    return await next(req);
  } catch (err) {
    if (err instanceof ConnectError) {
      if (err.code === Code.Unauthenticated) {
        triggerAuthError('UNAUTHENTICATED', 'Local authentication required');
      } else if (err.code === Code.Internal) {
        try {
          const status = await checkStatus();
          if (status.error === 'UPSTREAM_AUTH_REQUIRED') {
            triggerAuthError('UPSTREAM_AUTH_REQUIRED', status.message || 'GitHub authentication required');
          }
        } catch (statusErr) {
          console.error('Failed to check backend status on Code.Internal:', statusErr);
        }
      }
    }
    throw err;
  }
};

export const transport = createConnectTransport({
  baseUrl: BASE_URL,
  interceptors: [authInterceptor],
});

export const client = createClient(OctoDeckService, transport);
