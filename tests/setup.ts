/**
 * Global vitest setup — runs before every test file.
 *
 * Problem: `npm ci --ignore-scripts` skips the electron postinstall script,
 * so `node_modules/electron/path.txt` is never created.  When any module
 * executes `module.exports = getElectronPath()` (electron/index.js) it throws
 * "Electron failed to install correctly…", killing the test file at import
 * time and producing a "0 tests" result in CI.
 *
 * Fix: mock the `electron` module globally so the CJS initialisation code is
 * never reached.  Tests that supply their own `vi.mock('electron', …)` will
 * still override this default mock inside their own scope.
 */
import { vi } from 'vitest';

vi.mock('electron', () => ({
  default: '/mock/electron',
  app: {
    isPackaged: false,
    getPath: (_name: string) => '/tmp/open-cowork-test',
    getVersion: () => '0.0.0-test',
    getName: () => 'open-cowork-test',
    getLocale: () => 'en',
    on: vi.fn(),
    whenReady: () => Promise.resolve(),
    quit: vi.fn(),
  },
  ipcMain: {
    on: vi.fn(),
    handle: vi.fn(),
    removeAllListeners: vi.fn(),
    removeHandler: vi.fn(),
  },
  ipcRenderer: {
    on: vi.fn(),
    send: vi.fn(),
    invoke: () => Promise.resolve(null),
    sendSync: () => null,
    removeAllListeners: vi.fn(),
  },
  BrowserWindow: vi.fn(() => ({
    loadURL: vi.fn(),
    on: vi.fn(),
    webContents: { send: vi.fn() },
  })),
  dialog: {
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    showMessageBox: () => Promise.resolve({ response: 0 }),
  },
  shell: {
    openExternal: vi.fn(),
    openPath: vi.fn(),
  },
  nativeTheme: {
    shouldUseDarkColors: false,
    on: vi.fn(),
  },
}));
