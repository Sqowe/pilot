import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

// Import from the CommonJS script using createRequire
const require = createRequire(import.meta.url);
const { PHOTON_WASM_FILENAME, resolvePhotonWasmPath } = require('../../scripts/photon-wasm.js');

// These pin what the main build relies on (vite.config.ts emits the file next to the
// bundle). A pi uplift that drops photon-node, renames the file or loads it some other
// way fails here instead of silently dropping attached images in the built app.
describe('photon-wasm: resolvePhotonWasmPath', () => {
  it('finds the wasm file shipped by the photon-node that pi-coding-agent depends on', () => {
    const wasmPath = resolvePhotonWasmPath();

    expect(path.basename(wasmPath)).toBe(PHOTON_WASM_FILENAME);
    // "\0asm" — the WebAssembly binary magic number
    expect(fs.readFileSync(wasmPath).subarray(0, 4)).toEqual(Buffer.from([0x00, 0x61, 0x73, 0x6d]));
  });

  it('photon-node still reads that file from its own directory', () => {
    const photonDir = path.dirname(resolvePhotonWasmPath());
    const { main } = JSON.parse(fs.readFileSync(path.join(photonDir, 'package.json'), 'utf-8'));
    const entrySource = fs.readFileSync(path.join(photonDir, main), 'utf-8');

    expect(entrySource).toContain(`join(__dirname, '${PHOTON_WASM_FILENAME}')`);
  });

  it('throws when pi-coding-agent is not installed under the given root', () => {
    expect(() => resolvePhotonWasmPath(path.parse(process.cwd()).root)).toThrow(
      /pi-coding-agent is not installed/
    );
  });
});
