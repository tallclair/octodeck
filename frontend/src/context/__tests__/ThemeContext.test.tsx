import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ThemeProvider, useTheme } from '../ThemeContext';

function TestConsumer() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolvedTheme">{resolvedTheme}</span>
      <button onClick={() => setTheme('light')}>Set Light</button>
      <button onClick={() => setTheme('dark')}>Set Dark</button>
      <button onClick={() => setTheme('system')}>Set System</button>
    </div>
  );
}

describe('ThemeContext & ThemeProvider', () => {
  let matchMediaListeners: Array<(e: { matches: boolean }) => void> = [];
  let matchesDark = true;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    matchMediaListeners = [];
    matchesDark = true;

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('dark') ? matchesDark : !matchesDark,
      media: query,
      onchange: null,
      addListener: vi.fn((listener) => matchMediaListeners.push(listener)),
      removeListener: vi.fn(),
      addEventListener: vi.fn((_, listener) => matchMediaListeners.push(listener)),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to system theme and applies dark class when system prefers dark', () => {
    matchesDark = true;
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );

    expect(screen.getByTestId('theme').textContent).toBe('system');
    expect(screen.getByTestId('resolvedTheme').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('defaults to system theme and removes dark class when system prefers light', () => {
    matchesDark = false;
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );

    expect(screen.getByTestId('theme').textContent).toBe('system');
    expect(screen.getByTestId('resolvedTheme').textContent).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('updates theme to light, persists to localStorage, and updates document classes', () => {
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );

    act(() => {
      screen.getByText('Set Light').click();
    });

    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(screen.getByTestId('resolvedTheme').textContent).toBe('light');
    expect(localStorage.getItem('octodeck_theme')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('updates theme to dark, persists to localStorage, and updates document classes', () => {
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );

    act(() => {
      screen.getByText('Set Dark').click();
    });

    expect(screen.getByTestId('theme').textContent).toBe('dark');
    expect(screen.getByTestId('resolvedTheme').textContent).toBe('dark');
    expect(localStorage.getItem('octodeck_theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('initializes from stored localStorage value if present', () => {
    localStorage.setItem('octodeck_theme', 'light');

    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );

    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(screen.getByTestId('resolvedTheme').textContent).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('responds dynamically to system theme change events when theme is system', () => {
    matchesDark = true;
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );

    expect(screen.getByTestId('resolvedTheme').textContent).toBe('dark');

    // Simulate OS theme change to light
    act(() => {
      matchMediaListeners.forEach((listener) => listener({ matches: false }));
    });

    expect(screen.getByTestId('resolvedTheme').textContent).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('provides safe fallback when useTheme is called outside ThemeProvider', () => {
    render(<TestConsumer />);
    expect(screen.getByTestId('theme').textContent).toBe('system');
    expect(screen.getByTestId('resolvedTheme').textContent).toBe('dark');
  });
});
