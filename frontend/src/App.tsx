import { useState, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@connectrpc/connect-query';
import { transport, onAuthError } from './api/client';
import { ThemeProvider } from './context/ThemeContext';
import { Dashboard } from './components/Dashboard';
import { DataBrowser } from './components/DataBrowser';
import { AlertTriangle, Terminal } from 'lucide-react';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      staleTime: 5000,
    },
  },
});

function getInitialView(): 'dashboard' | 'debug' {
  if (typeof window === 'undefined') return 'dashboard';
  const pathname = window.location.pathname;
  const hash = window.location.hash;
  return pathname.startsWith('/debug') || hash === '#debug' ? 'debug' : 'dashboard';
}

function getInitialDebugItemId(): string | null {
  if (typeof window === 'undefined') return null;
  const searchParams = new URLSearchParams(window.location.search);
  return searchParams.get('item');
}

function getInitialDebugTab(): 'items' | 'traces' | 'config' {
  if (typeof window === 'undefined') return 'items';
  const searchParams = new URLSearchParams(window.location.search);
  const tab = searchParams.get('tab');
  return tab === 'traces' || tab === 'config' ? tab : 'items';
}

function AppContent() {
  const [view, setView] = useState<'dashboard' | 'debug'>(getInitialView);
  const [focusedItemId, setFocusedItemId] = useState<string | null>(getInitialDebugItemId);
  const [debugTab, setDebugTab] = useState<'items' | 'traces' | 'config'>(getInitialDebugTab);
  const [authError, setAuthError] = useState<{ error: string; message: string } | null>(null);

  useEffect(() => {
    const handlePopState = () => {
      setView(getInitialView());
      setFocusedItemId(getInitialDebugItemId());
      setDebugTab(getInitialDebugTab());
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigateTo = (newView: 'dashboard' | 'debug', targetItemId?: string, targetTab?: 'items' | 'traces' | 'config') => {
    setView(newView);
    setFocusedItemId(targetItemId ?? null);
    if (targetTab) {
      setDebugTab(targetTab);
    }
    try {
      if (typeof window !== 'undefined' && window.history) {
        let targetPath = newView === 'debug' ? '/debug' : '/';
        const params = new URLSearchParams();
        if (targetItemId) {
          params.set('item', targetItemId);
        }
        if (newView === 'debug' && targetTab && targetTab !== 'items') {
          params.set('tab', targetTab);
        }
        const qs = params.toString();
        if (qs) {
          targetPath += `?${qs}`;
        }
        const currentFullPath = window.location.pathname + window.location.search;
        if (currentFullPath !== targetPath) {
          window.history.pushState(null, '', targetPath);
        }
      }
    } catch (e) {
      console.warn('Failed to update browser history', e);
    }
  };

  useEffect(() => {
    return onAuthError((error: string, message?: string) => {
      if (error === 'UPSTREAM_AUTH_REQUIRED') {
        setAuthError({
          error,
          message: message || "GitHub authentication required. Please run 'gh auth login' in your terminal.",
        });
      }
    });
  }, []);

  if (view === 'debug') {
    return (
      <DataBrowser
        initialSelectedItemId={focusedItemId || undefined}
        initialTab={debugTab}
        onBack={(targetItemId) => navigateTo('dashboard', targetItemId)}
      />
    );
  }

  return (
    <>
      {authError && (
        <div className="bg-amber-100 dark:bg-amber-950 border-b border-amber-300 dark:border-amber-800 text-amber-900 dark:text-amber-200 px-6 py-3 flex items-center justify-between z-50">
          <div className="flex items-center gap-3">
            <AlertTriangle className="text-amber-600 dark:text-amber-400 shrink-0" size={20} />
            <div>
              <p className="font-semibold text-sm">GitHub Auth Required</p>
              <p className="text-xs text-amber-800/80 dark:text-amber-300/80 flex items-center gap-1.5 mt-0.5 font-mono">
                <Terminal size={12} /> Run <code className="bg-amber-200 dark:bg-amber-900/60 px-1 py-0.5 rounded text-amber-950 dark:text-white">gh auth login</code> in your terminal to connect OctoDeck.
              </p>
            </div>
          </div>
          <button
            onClick={() => setAuthError(null)}
            className="text-xs bg-amber-200 hover:bg-amber-300 dark:bg-amber-900/80 dark:hover:bg-amber-800 px-3 py-1.5 rounded font-medium text-amber-900 dark:text-amber-100 transition cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}
      <Dashboard onOpenDebug={(targetItemId) => navigateTo('debug', targetItemId)} />
    </>
  );
}

function App() {
  return (
    <ThemeProvider>
      <TransportProvider transport={transport}>
        <QueryClientProvider client={queryClient}>
          <AppContent />
        </QueryClientProvider>
      </TransportProvider>
    </ThemeProvider>
  );
}

export default App;