import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import archiver from 'archiver';

let testRoot = '';

vi.mock('electron', () => {
  const electron = {
    app: {
      getName: () => 'open-cowork-test',
      getVersion: () => '0.0.0-test',
      getPath: (name: string) => {
        if (name === 'userData') return path.join(testRoot, 'userData');
        if (name === 'temp') return path.join(testRoot, 'temp');
        if (name === 'home') return path.join(testRoot, 'home');
        return testRoot;
      },
    },
  };

  return {
    ...electron,
    default: electron,
  };
});

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

/**
 * Create a plugin directory fixture with manifest and one skill.
 */
function createPluginDirectory(root: string, pluginName: string): string {
  const pluginRoot = path.join(root, pluginName);
  fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify(
      { name: pluginName, version: '1.0.0', description: `${pluginName} plugin` },
      null,
      2
    ),
    'utf8'
  );
  fs.mkdirSync(path.join(pluginRoot, 'skills', 'alpha'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, 'skills', 'alpha', 'SKILL.md'),
    '---\nname: alpha\ndescription: Alpha skill\n---\n',
    'utf8'
  );
  return pluginRoot;
}

/**
 * Create a zip archive from a directory using the archiver library (in-process, portable).
 */
async function createZipFromDirectory(sourceDir: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 0 } });

    output.on('close', () => resolve());
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, path.basename(sourceDir));
    archive.finalize();
  });
}

/**
 * Create a minimal valid ZIP file with a single entry having an arbitrary filename.
 * This bypasses archiver's sanitization to test extraction-level safety checks.
 * ZIP format: [local file header + data] ... [central directory] [end of central directory]
 */
function createMaliciousZip(outputPath: string, entryName: string, content: string): void {
  const fileNameBuf = Buffer.from(entryName, 'utf8');
  const contentBuf = Buffer.from(content, 'utf8');
  const crc = crc32(contentBuf);

  // Local file header
  const localHeader = Buffer.alloc(30 + fileNameBuf.length);
  localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
  localHeader.writeUInt16LE(20, 4); // version needed
  localHeader.writeUInt16LE(0, 6); // general purpose bit flag
  localHeader.writeUInt16LE(0, 8); // compression method (stored)
  localHeader.writeUInt16LE(0, 10); // last mod time
  localHeader.writeUInt16LE(0, 12); // last mod date
  localHeader.writeUInt32LE(crc, 14); // crc-32
  localHeader.writeUInt32LE(contentBuf.length, 18); // compressed size
  localHeader.writeUInt32LE(contentBuf.length, 22); // uncompressed size
  localHeader.writeUInt16LE(fileNameBuf.length, 26); // file name length
  localHeader.writeUInt16LE(0, 28); // extra field length
  fileNameBuf.copy(localHeader, 30);

  // Central directory header
  const centralHeader = Buffer.alloc(46 + fileNameBuf.length);
  centralHeader.writeUInt32LE(0x02014b50, 0); // central dir signature
  centralHeader.writeUInt16LE(20, 4); // version made by
  centralHeader.writeUInt16LE(20, 6); // version needed
  centralHeader.writeUInt16LE(0, 8); // general purpose bit flag
  centralHeader.writeUInt16LE(0, 10); // compression method
  centralHeader.writeUInt16LE(0, 12); // last mod time
  centralHeader.writeUInt16LE(0, 14); // last mod date
  centralHeader.writeUInt32LE(crc, 16); // crc-32
  centralHeader.writeUInt32LE(contentBuf.length, 20); // compressed size
  centralHeader.writeUInt32LE(contentBuf.length, 24); // uncompressed size
  centralHeader.writeUInt16LE(fileNameBuf.length, 28); // file name length
  centralHeader.writeUInt16LE(0, 30); // extra field length
  centralHeader.writeUInt16LE(0, 32); // file comment length
  centralHeader.writeUInt16LE(0, 34); // disk number start
  centralHeader.writeUInt16LE(0, 36); // internal file attributes
  centralHeader.writeUInt32LE(0, 38); // external file attributes
  centralHeader.writeUInt32LE(0, 42); // relative offset of local header
  fileNameBuf.copy(centralHeader, 46);

  const centralDirOffset = localHeader.length + contentBuf.length;

  // End of central directory
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0); // end of central dir signature
  endRecord.writeUInt16LE(0, 4); // disk number
  endRecord.writeUInt16LE(0, 6); // disk with central dir
  endRecord.writeUInt16LE(1, 8); // entries on this disk
  endRecord.writeUInt16LE(1, 10); // total entries
  endRecord.writeUInt32LE(centralHeader.length, 12); // central dir size
  endRecord.writeUInt32LE(centralDirOffset, 16); // central dir offset
  endRecord.writeUInt16LE(0, 20); // comment length

  const zipBuffer = Buffer.concat([localHeader, contentBuf, centralHeader, endRecord]);
  fs.writeFileSync(outputPath, zipBuffer);
}

/**
 * Simple CRC-32 computation for ZIP file creation.
 */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function createRuntimeService() {
  const { PluginRuntimeService } = await import('../src/main/skills/plugin-runtime-service');
  const fakeCatalogService = {
    listAnthropicPlugins: vi.fn(),
    downloadPlugin: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return new PluginRuntimeService(fakeCatalogService);
}

describe('PluginRuntimeService.installFromArchive', () => {
  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cowork-archive-test-'));
    fs.mkdirSync(path.join(testRoot, 'userData'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'temp'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'home'), { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('installs from a .zip archive', async () => {
    const fixturesRoot = path.join(testRoot, 'fixtures');
    createPluginDirectory(fixturesRoot, 'my-plugin');

    const archivePath = path.join(testRoot, 'my-plugin.zip');
    await createZipFromDirectory(path.join(fixturesRoot, 'my-plugin'), archivePath);

    const service = await createRuntimeService();
    const result = await service.installFromArchive(archivePath);

    expect(result.plugin.name).toBe('my-plugin');
    expect(result.plugin.pluginId).toBe('my-plugin');
    expect(result.installedSkills).toContain('alpha');
  });

  it('installs from a .plugin archive', async () => {
    const fixturesRoot = path.join(testRoot, 'fixtures');
    createPluginDirectory(fixturesRoot, 'test-plugin');

    const zipPath = path.join(testRoot, 'test-plugin.zip');
    await createZipFromDirectory(path.join(fixturesRoot, 'test-plugin'), zipPath);
    const pluginPath = path.join(testRoot, 'test-plugin.plugin');
    fs.renameSync(zipPath, pluginPath);

    const service = await createRuntimeService();
    const result = await service.installFromArchive(pluginPath);

    expect(result.plugin.name).toBe('test-plugin');
    expect(result.installedSkills).toContain('alpha');
  });

  it('handles archive with single top-level directory', async () => {
    const fixturesRoot = path.join(testRoot, 'fixtures');
    createPluginDirectory(fixturesRoot, 'nested-plugin');

    const archivePath = path.join(testRoot, 'nested.zip');
    await createZipFromDirectory(path.join(fixturesRoot, 'nested-plugin'), archivePath);

    const service = await createRuntimeService();
    const result = await service.installFromArchive(archivePath);

    expect(result.plugin.name).toBe('nested-plugin');
    expect(result.installedSkills).toContain('alpha');
  });

  it('ignores __MACOSX metadata directory when detecting plugin root', async () => {
    const fixturesRoot = path.join(testRoot, 'fixtures');
    const archiveContent = path.join(fixturesRoot, 'archive-content');
    createPluginDirectory(archiveContent, 'real-plugin');

    // Create archive with both real-plugin/ and __MACOSX/ at root
    const archivePath = path.join(testRoot, 'with-macosx.zip');
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(archivePath);
      const archive = archiver('zip', { zlib: { level: 0 } });
      output.on('close', () => resolve());
      archive.on('error', reject);
      archive.pipe(output);
      archive.directory(path.join(archiveContent, 'real-plugin'), 'real-plugin');
      archive.append(Buffer.from('metadata'), { name: '__MACOSX/._real-plugin' });
      archive.finalize();
    });

    const service = await createRuntimeService();
    const result = await service.installFromArchive(archivePath);

    expect(result.plugin.name).toBe('real-plugin');
    expect(result.installedSkills).toContain('alpha');
  });

  it('rejects unsupported file extensions', async () => {
    const fakePath = path.join(testRoot, 'bad-file.tar.gz');
    fs.writeFileSync(fakePath, 'not a zip', 'utf8');

    const service = await createRuntimeService();
    await expect(service.installFromArchive(fakePath)).rejects.toThrow(
      'Unsupported archive format'
    );
  });

  it('rejects non-existent archive path', async () => {
    const service = await createRuntimeService();
    await expect(service.installFromArchive('/no/such/file.zip')).rejects.toThrow(
      'Plugin archive not found'
    );
  });

  it('rejects path that is a directory, not a file', async () => {
    const dirPath = path.join(testRoot, 'not-a-file.zip');
    fs.mkdirSync(dirPath, { recursive: true });

    const service = await createRuntimeService();
    await expect(service.installFromArchive(dirPath)).rejects.toThrow(
      'Plugin archive path is not a file'
    );
  });

  it('cleans up temp directory after successful install', async () => {
    const fixturesRoot = path.join(testRoot, 'fixtures');
    createPluginDirectory(fixturesRoot, 'cleanup-test');
    const archivePath = path.join(testRoot, 'cleanup-test.zip');
    await createZipFromDirectory(path.join(fixturesRoot, 'cleanup-test'), archivePath);

    // Snapshot temp dirs before install
    const tmpBefore = new Set(
      fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('cowork-plugin-'))
    );

    const service = await createRuntimeService();
    await service.installFromArchive(archivePath);

    // No new cowork-plugin-* temp dirs should remain
    const tmpAfter = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('cowork-plugin-'));
    const newDirs = tmpAfter.filter((f) => !tmpBefore.has(f));
    expect(newDirs).toHaveLength(0);
  });

  it('cleans up temp directory after failed install (corrupt archive)', async () => {
    const corruptPath = path.join(testRoot, 'corrupt.zip');
    fs.writeFileSync(corruptPath, 'this is not a valid zip file', 'utf8');

    const tmpBefore = new Set(
      fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('cowork-plugin-'))
    );

    const service = await createRuntimeService();
    await expect(service.installFromArchive(corruptPath)).rejects.toThrow();

    const tmpAfter = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('cowork-plugin-'));
    const newDirs = tmpAfter.filter((f) => !tmpBefore.has(f));
    expect(newDirs).toHaveLength(0);
  });

  it('rejects archives containing symlink entries', async () => {
    // archiver supports symlinks via the 'symlink' mode in entry data
    const archivePath = path.join(testRoot, 'symlink-archive.zip');
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(archivePath);
      const archive = archiver('zip', { zlib: { level: 0 } });
      output.on('close', () => resolve());
      archive.on('error', reject);
      archive.pipe(output);
      // Add a normal file
      archive.append(Buffer.from('content'), { name: 'plugin/file.txt' });
      // Add a symlink entry (archiver supports this via mode)
      archive.symlink('plugin/evil-link', '/etc/passwd');
      archive.finalize();
    });

    const service = await createRuntimeService();
    await expect(service.installFromArchive(archivePath)).rejects.toThrow(/symlink/i);
  });

  it('rejects archives with path traversal entries', async () => {
    // Create a minimal zip with a path traversal entry using raw bytes.
    // yauzl will parse this and our extraction code must reject it.
    const archivePath = path.join(testRoot, 'traversal.zip');
    createMaliciousZip(archivePath, '../../../etc/evil.txt', 'pwned');

    const service = await createRuntimeService();
    await expect(service.installFromArchive(archivePath)).rejects.toThrow(
      /traversal|escapes|invalid.*relative.*path/i
    );
  });

  it('rejects archives with absolute path entries', async () => {
    const archivePath = path.join(testRoot, 'absolute.zip');
    createMaliciousZip(archivePath, '/etc/passwd', 'evil');

    const service = await createRuntimeService();
    await expect(service.installFromArchive(archivePath)).rejects.toThrow(/absolute/i);
  });
});
