/**
 * Locates the wasm file pi-coding-agent's image library reads when it loads.
 *
 * pi-coding-agent resizes images through @silvia-odwyer/photon-node, whose CommonJS
 * entry reads `photon_rs_bg.wasm` from its own __dirname. Vite bundles pi into
 * dist-electron/main, where __dirname is the bundle's directory, so the build has to
 * put the file there (see vite.config.ts). Without it photon fails to load, pi
 * swallows the error, and every user-attached image and every image the `read` tool
 * opens is dropped before the request is sent.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const PHOTON_PACKAGE = '@silvia-odwyer/photon-node';
const PHOTON_WASM_FILENAME = 'photon_rs_bg.wasm';

/**
 * Find an installed package's directory the way Node would look it up from `fromDir`.
 * pi-coding-agent exports only an `import` condition, so require.resolve() refuses it.
 *
 * @param {string} packageName
 * @param {string} fromDir
 * @returns {string}
 */
function findPackageDir(packageName, fromDir) {
  const lookupPaths = createRequire(path.join(fromDir, 'package.json')).resolve.paths(packageName);

  for (const lookupPath of lookupPaths || []) {
    const candidate = path.join(lookupPath, packageName);
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
  }

  throw new Error(`${packageName} is not installed (looked from ${fromDir})`);
}

/**
 * @param {string} [rootDir] - Project root; defaults to this repository
 * @returns {string} Absolute path to photon_rs_bg.wasm
 */
function resolvePhotonWasmPath(rootDir = path.join(__dirname, '..')) {
  const piDir = findPackageDir(PI_PACKAGE, rootDir);
  // photon-node is pi's dependency, not ours — resolve it from where pi is installed.
  const photonEntry = createRequire(path.join(piDir, 'package.json')).resolve(PHOTON_PACKAGE);
  const wasmPath = path.join(path.dirname(photonEntry), PHOTON_WASM_FILENAME);

  if (!fs.existsSync(wasmPath)) {
    throw new Error(`${PHOTON_WASM_FILENAME} not found next to ${photonEntry}`);
  }

  return wasmPath;
}

module.exports = { PHOTON_WASM_FILENAME, resolvePhotonWasmPath };
