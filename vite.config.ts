import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { builtinModules, createRequire } from 'module';

const { PHOTON_WASM_FILENAME, resolvePhotonWasmPath } = createRequire(import.meta.url)(
  './scripts/photon-wasm.js'
) as { PHOTON_WASM_FILENAME: string; resolvePhotonWasmPath: () => string };

// Node built-in modules must be external for Electron main process
const nodeBuiltins = builtinModules.flatMap((m) => [m, `node:${m}`]);

// pi-coding-agent's image library reads its wasm from __dirname, which in the bundle
// is the main build's outDir — emit it there (details in scripts/photon-wasm.js).
function emitPhotonWasm(): Plugin {
  return {
    name: 'emit-photon-wasm',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: PHOTON_WASM_FILENAME,
        source: readFileSync(resolvePhotonWasmPath()),
      });
    },
  };
}
const ignoredWatchPaths = [
  '**/release/**',
  '**/dist/**',
  '**/dist-electron/**',
  '**/dist-wsl-agent/**',
  '**/dist-lima-agent/**',
  '**/dist-mcp/**',
];

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'src/main/index.ts',
        onstart(args) {
          args.startup();
        },
        vite: {
          plugins: [emitPhotonWasm()],
          build: {
            outDir: 'dist-electron/main',
            // vite-plugin-electron turns this off by default; without it every rebuild
            // leaves its hashed chunks behind and electron-builder ships all of them.
            emptyOutDir: true,
            rollupOptions: {
              external: [
                ...nodeBuiltins,
                'better-sqlite3',
                'bufferutil',
                'utf-8-validate',
                'electron',
                // Native ONNX runtime + image lib for local embeddings
                // (@huggingface/transformers). These load a .node binding via
                // dynamic require, which Rollup can't bundle — keep them
                // external so they resolve from node_modules at runtime.
                'onnxruntime-node',
                'onnxruntime-common',
                'sharp',
                // Externalize large CJS-compatible main-process dependencies
                // NOTE: ESM-only packages (pi-coding-agent, pi-ai, electron-store, uuid)
                // must stay bundled — CJS require() can't load them
                '@anthropic-ai/sdk',
                '@larksuiteoapi/node-sdk',
                'openai',
                '@modelcontextprotocol/sdk',
                'electron-updater',
                'chokidar',
                'archiver',
                'ngrok',
                'ws',
                'glob',
                'dotenv',
              ],
              output: {
                // Ensure consistent interop for CJS/ESM
                interop: 'auto',
              },
            },
          },
        },
      },
      {
        entry: 'src/preload/index.ts',
        onstart(args) {
          args.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron/preload',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
    ]),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@main': resolve(__dirname, 'src/main'),
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
  server: {
    watch: {
      ignored: ignoredWatchPaths,
    },
  },
  build: {
    sourcemap: process.env.NODE_ENV !== 'production',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
