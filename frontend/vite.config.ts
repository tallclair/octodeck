/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'

const isWebApp = process.env.BUILD_TARGET === 'webapp';
const isContent = process.env.BUILD_TARGET === 'extension-content';
const isExtension = !isWebApp && !isContent;

function getAppVersion(): { full: string; numeric: string } {
  let full = process.env.APP_VERSION || process.env.OCTODECK_VERSION || '';
  if (!full) {
    try {
      full = execSync('git describe --tags --match "v*" --always --dirty', {
        cwd: __dirname,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      full = 'dev';
    }
  }
  if (!full) {
    full = 'dev';
  }

  const match = full.match(/^v?(\d+\.\d+\.\d+)/);
  const numeric = match ? match[1] : '0.0.0';
  return { full, numeric };
}

const { full: appVersion, numeric: numericVersion } = getAppVersion();

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'copy-extension-manifest',
      closeBundle() {
        if (isExtension) {
          const manifestSrc = resolve(__dirname, 'src/extension/manifest.json');
          const stylesSrc = resolve(__dirname, 'src/extension/content/styles.css');
          const outDir = resolve(__dirname, '../extension_dist');
          if (!existsSync(outDir)) {
            mkdirSync(outDir, { recursive: true });
          }
          if (existsSync(manifestSrc)) {
            const manifestRaw = readFileSync(manifestSrc, 'utf8');
            const manifest = JSON.parse(manifestRaw);
            manifest.version = numericVersion;
            manifest.version_name = appVersion;
            writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
          }
          if (existsSync(stylesSrc)) {
            copyFileSync(stylesSrc, resolve(outDir, 'content.css'));
          }
          const nestedHtml = resolve(outDir, 'src/extension/options.html');
          if (existsSync(nestedHtml)) {
            copyFileSync(nestedHtml, resolve(outDir, 'options.html'));
            rmSync(resolve(outDir, 'src'), { recursive: true, force: true });
          }
        }
      },
    },
  ],
  define: {
    __IS_EXTENSION__: JSON.stringify(isExtension || isContent),
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      clientPort: 5173,
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
  build: isContent
    ? {
        rollupOptions: {
          input: resolve(__dirname, 'src/extension/content.ts'),
          output: {
            format: 'iife',
            entryFileNames: 'content.js',
            extend: true,
          },
        },
      }
    : {
        rollupOptions: {
          input: isExtension
            ? {
                background: resolve(__dirname, 'src/extension/background.ts'),
                options: resolve(__dirname, 'src/extension/options.html'),
              }
            : {
                index: resolve(__dirname, 'index.html'),
              },
          output: {
            entryFileNames: '[name].js',
            chunkFileNames: 'assets/[name]-[hash].js',
            assetFileNames: '[name].[ext]',
            manualChunks(id) {
              if (id.includes('node_modules')) {
                if (
                  id.includes('/react/') ||
                  id.includes('/react-dom/') ||
                  id.includes('/scheduler/')
                ) {
                  return 'vendor-react';
                }
                if (id.includes('lucide-react')) {
                  return 'vendor-lucide';
                }
                if (
                  id.includes('@connectrpc') ||
                  id.includes('@bufbuild') ||
                  id.includes('@tanstack/react-query')
                ) {
                  return 'vendor-rpc';
                }
                if (id.includes('react-markdown') || id.includes('remark-gfm')) {
                  return 'vendor-markdown';
                }
                return 'vendor';
              }
            },
          },
        },
      },
})
