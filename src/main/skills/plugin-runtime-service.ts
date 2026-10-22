import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app } from 'electron';
import type {
  InstalledPlugin,
  PluginCatalogItemV2,
  PluginComponentCounts,
  PluginComponentEnabledState,
  PluginComponentKind,
  PluginGitHubSource,
  PluginGitHubUpdateResult,
  PluginInstallResultV2,
  PluginToggleResult,
} from '../../renderer/types';
import {
  isValidGitHubOwner,
  isValidGitHubRepoName,
  isValidGitRef,
  normalizeRepoSubpath,
  parseGitHubPluginUrl,
  type GitHubPluginLocation,
} from '../../shared/plugin-github-url';
import { log, logError } from '../utils/logger';
import { isPathWithinRoot } from '../tools/path-containment';
import { getDefaultShell } from '../utils/shell-resolver';
import { withRetry } from '../utils/retry';
import { pluginRegistryStore } from './plugin-registry-store';
import { PluginCatalogService } from './plugin-catalog-service';
import {
  PluginGitHubFailure,
  downloadGitHubArchive,
  isCommitSha,
  resolveCommitSha,
} from './plugin-github-source';

const execFileAsync = promisify(execFile);

/**
 * Extraction of a 500 MB archive (the size cap) takes well under a minute on a
 * laptop disk; five minutes leaves room for a slow or busy machine while still
 * ending a stall.
 */
const DEFAULT_EXTRACT_TIMEOUT_MS = 5 * 60 * 1000;

/** Opens a zip for reading entry by entry, the way `extractZipSafe` uses it. */
export type ZipOpener = (archivePath: string) => Promise<import('yauzl').ZipFile>;

const openWithYauzl: ZipOpener = (archivePath) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const yauzl = require('yauzl') as typeof import('yauzl');
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, decodeStrings: true }, (err, zf) => {
      if (err) return reject(err);
      if (!zf) return reject(new Error('Failed to open zip file'));
      resolve(zf);
    });
  });
};

interface PluginManifest {
  name?: string;
  description?: string;
  version?: string;
  author?: string | { name?: string };
  commands?: string | string[];
  agents?: string | string[];
  hooks?: string | Record<string, unknown>;
  mcpServers?: string | Record<string, unknown>;
  [key: string]: unknown;
}

interface CommandOutput {
  stdout: string;
  stderr: string;
}

type CommandRunner = (command: string, args: string[]) => Promise<CommandOutput>;

interface ClaudeInstalledPluginRecord {
  id?: string;
  installPath?: string;
}

interface ClaudePluginListOutput {
  installed?: ClaudeInstalledPluginRecord[];
}

/** What `extractZipSafe` reports besides the extracted files. */
interface ZipExtractionResult {
  /** The archive comment; a GitHub archive holds its commit id there. */
  comment: string;
  /** Symbolic-link entries that were not extracted, as named in the archive. */
  skippedSymlinks: string[];
}

interface InstallFromDirectoryOptions {
  /** Name to use when the plugin has no `plugin.json` name (instead of the folder name). */
  fallbackName?: string;
  /** Recorded so the plugin can be updated from where it came from. */
  source?: PluginGitHubSource;
  /** The installed entry being updated: its install date and switches are kept. */
  preserve?: InstalledPlugin;
}

interface LocatedGitHubPlugin {
  /** Absolute plugin root inside the extracted repository. */
  root: string;
  /** The same, relative to the repository root with forward slashes; undefined = the root. */
  relativePath?: string;
  fallbackName: string;
}

interface MarketplaceManifest {
  plugins?: Array<{ name?: unknown; source?: unknown }>;
  metadata?: { pluginRoot?: unknown };
}

const EMPTY_COUNTS: PluginComponentCounts = {
  skills: 0,
  commands: 0,
  agents: 0,
  hooks: 0,
  mcp: 0,
};

const EMPTY_COMPONENT_STATE: PluginComponentEnabledState = {
  skills: false,
  commands: false,
  agents: false,
  hooks: false,
  mcp: false,
};

function cloneCounts(counts: PluginComponentCounts): PluginComponentCounts {
  return {
    skills: counts.skills,
    commands: counts.commands,
    agents: counts.agents,
    hooks: counts.hooks,
    mcp: counts.mcp,
  };
}

function cloneComponentState(state: PluginComponentEnabledState): PluginComponentEnabledState {
  return {
    skills: state.skills,
    commands: state.commands,
    agents: state.agents,
    hooks: state.hooks,
    mcp: state.mcp,
  };
}

export class PluginRuntimeService {
  private readonly catalogService: PluginCatalogService;
  private readonly commandRunner: CommandRunner;
  private readonly fetchFn: typeof fetch;
  /** Longest an archive may take to extract before the install fails (all install paths). */
  private readonly extractTimeoutMs: number;
  /** Opens an archive for reading; yauzl unless a test hands in a stand-in. */
  private readonly openZip: ZipOpener;

  constructor(
    catalogService: PluginCatalogService = new PluginCatalogService(),
    commandRunner: CommandRunner = PluginRuntimeService.defaultCommandRunner,
    // Read at call time, so whatever global fetch is in place then is used.
    fetchFn: typeof fetch = (input, init) => fetch(input, init),
    options: { extractTimeoutMs?: number; openZip?: ZipOpener } = {}
  ) {
    this.catalogService = catalogService;
    this.commandRunner = commandRunner;
    this.fetchFn = fetchFn;
    this.extractTimeoutMs = options.extractTimeoutMs ?? DEFAULT_EXTRACT_TIMEOUT_MS;
    this.openZip = options.openZip ?? openWithYauzl;
  }

  async listCatalog(options?: { installableOnly?: boolean }): Promise<PluginCatalogItemV2[]> {
    const installableOnly = options?.installableOnly === true;
    const plugins = await this.catalogService.listAnthropicPlugins(false, installableOnly);
    return plugins.map((plugin) => ({
      name: plugin.name,
      description: plugin.description,
      version: plugin.version,
      authorName: plugin.authorName,
      installable: plugin.installable,
      hasManifest: plugin.hasManifest,
      componentCounts: cloneCounts(plugin.componentCounts),
      pluginId: plugin.pluginId,
      installCommand: plugin.installCommand,
      detailUrl: plugin.detailUrl,
      catalogSource: plugin.catalogSource,
    }));
  }

  listInstalled(): InstalledPlugin[] {
    return pluginRegistryStore.list().map((plugin) => this.normalizeInstalledPlugin(plugin));
  }

  async install(pluginRef: string): Promise<PluginInstallResultV2> {
    log(`[PluginRuntime] Install requested: ${pluginRef}`);
    const catalog = await this.catalogService.listAnthropicPlugins(false, false);
    const requested = pluginRef.trim();
    const loweredRequested = requested.toLowerCase();
    const targetPlugin = this.resolveCatalogPlugin(catalog, loweredRequested);
    if (!targetPlugin) {
      throw new Error(`Plugin not found in marketplace catalog: ${pluginRef}`);
    }

    const pluginId = this.getCatalogPluginId(targetPlugin);
    if (!pluginId) {
      throw new Error(`Unable to resolve plugin id for ${pluginRef}`);
    }
    log(`[PluginRuntime] Resolved marketplace plugin id: ${pluginId} (from ${pluginRef})`);

    await this.installWithClaudeCli(pluginId);
    const pluginRootPath = await this.resolveInstallPathFromCli(pluginId);
    const result = await this.installFromDirectory(pluginRootPath);
    log(
      `[PluginRuntime] Install completed: ${result.plugin.name} (${result.plugin.pluginId}), source=${result.plugin.sourcePath}, runtime=${result.plugin.runtimePath}`
    );
    return result;
  }

  async installFromDirectory(
    pluginRootPath: string,
    options: InstallFromDirectoryOptions = {}
  ): Promise<PluginInstallResultV2> {
    if (!fs.existsSync(pluginRootPath) || !fs.statSync(pluginRootPath).isDirectory()) {
      throw new Error('Plugin directory does not exist');
    }
    log(`[PluginRuntime] Importing plugin directory: ${pluginRootPath}`);

    const sourceManifest = this.readManifest(pluginRootPath);
    const { displayName, pluginId } = this.resolvePluginIdentity(
      sourceManifest,
      options.fallbackName || path.basename(pluginRootPath)
    );
    const previous = options.preserve ? this.normalizeInstalledPlugin(options.preserve) : null;
    if (previous && previous.pluginId !== pluginId) {
      // Checked before anything is removed: the old files stay as they are.
      throw new PluginGitHubFailure('pluginRenamed', displayName);
    }
    const sourcePath = this.getSourcePath(pluginId);
    const runtimePath = this.getRuntimePath(pluginId);
    const componentCounts = this.detectComponentCounts(pluginRootPath, sourceManifest);

    await this.removePathWithRetries(sourcePath);
    await this.removePathWithRetries(runtimePath);
    this.copyDirectory(pluginRootPath, sourcePath);

    const now = Date.now();
    const defaultComponentState = this.getDefaultComponentState(componentCounts);
    const componentsEnabled = previous
      ? this.mergeComponentState(previous, componentCounts, defaultComponentState)
      : defaultComponentState;
    const hasAnyComponent = this.hasAnyEnabledComponent(defaultComponentState, componentCounts);
    const orchestratorSkill = this.detectOrchestrator(sourcePath);
    const installedPlugin: InstalledPlugin = {
      pluginId,
      name: displayName,
      description: sourceManifest?.description,
      version: sourceManifest?.version,
      authorName: this.resolveAuthorName(sourceManifest?.author),
      enabled: previous ? previous.enabled : hasAnyComponent,
      sourcePath,
      runtimePath,
      componentCounts,
      componentsEnabled,
      installedAt: previous?.installedAt ?? now,
      updatedAt: now,
      // undefined = scan failed (will be retried on next backfill)
      // null = scan succeeded, no orchestrator found
      // string = orchestrator skill name
      orchestratorSkill: orchestratorSkill,
      ...(options.source ? { source: { ...options.source } } : {}),
    };

    pluginRegistryStore.save(installedPlugin);
    await this.materializeRuntime(pluginId);

    const persisted = pluginRegistryStore.get(pluginId);
    if (!persisted) {
      throw new Error(`Failed to persist installed plugin: ${pluginId}`);
    }

    const warnings: string[] = [];
    if (!sourceManifest) {
      warnings.push('plugin.json not found, generated runtime manifest with defaults');
    }

    const result = {
      plugin: this.normalizeInstalledPlugin(persisted),
      installedSkills: this.listSkillNames(sourcePath),
      warnings,
    };
    log(
      `[PluginRuntime] Imported plugin: ${result.plugin.name} (${result.plugin.pluginId}), components=${JSON.stringify(result.plugin.componentCounts)}`
    );
    return result;
  }

  /**
   * Install a plugin from a local .plugin or .zip archive file.
   * Extracts the archive to a temporary directory and delegates to installFromDirectory.
   */
  async installFromArchive(archivePath: string): Promise<PluginInstallResultV2> {
    if (!fs.existsSync(archivePath)) {
      throw new Error('Plugin archive not found');
    }

    const stat = fs.statSync(archivePath);
    if (!stat.isFile()) {
      throw new Error('Plugin archive path is not a file');
    }

    const ext = path.extname(archivePath).toLowerCase();
    if (ext !== '.plugin' && ext !== '.zip') {
      throw new Error('Unsupported archive format. Expected .plugin or .zip file.');
    }

    // Use mkdtempSync for guaranteed unique temp directory
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-plugin-'));

    try {
      const extraction = await this.extractZipSafe(archivePath, tempDir);

      // Handle archives that contain a single top-level directory (common pattern).
      // Ignore known metadata entries like __MACOSX, .DS_Store, etc.
      const singleDir = this.findSingleTopDirectory(tempDir);
      let pluginRoot = tempDir;
      if (singleDir) {
        // Check if the plugin structure is inside the single directory
        const hasPluginMarker =
          fs.existsSync(path.join(singleDir, '.claude-plugin', 'plugin.json')) ||
          fs.existsSync(path.join(singleDir, 'skills'));
        if (hasPluginMarker) {
          pluginRoot = singleDir;
        }
      }

      const result = await this.installFromDirectory(pluginRoot);
      log(`[PluginRuntime] Archive install completed: ${result.plugin.name} from ${archivePath}`);
      return this.withSkippedSymlinks(
        result,
        this.stripTopFolder(
          extraction.skippedSymlinks,
          singleDir ? path.basename(singleDir) : undefined
        )
      );
    } finally {
      // Clean up temp directory; don't mask original errors on cleanup failure
      try {
        await this.removePathWithRetries(tempDir);
      } catch (cleanupErr) {
        logError(`[PluginRuntime] Failed to clean up temp directory: ${tempDir}`, cleanupErr);
      }
    }
  }

  /**
   * Install a plugin from a GitHub repository link (docs/design/plugin-github-install.md).
   * Downloads the commit as a zip, extracts it with the same checks as an archive
   * import, finds the plugin in it and records where it came from, for Update.
   * Failures are {@link PluginGitHubFailure}s with a code the renderer translates.
   */
  async installFromGitHub(input: string): Promise<PluginInstallResultV2> {
    const location = parseGitHubPluginUrl(input);
    if (!location) {
      throw new PluginGitHubFailure('invalidUrl');
    }
    log(
      `[PluginRuntime] GitHub install requested: ${location.owner}/${location.repo} ref=${location.ref ?? '(default)'} path=${location.path ?? '(root)'}`
    );

    const apiSha = await resolveCommitSha(location, { fetchFn: this.fetchFn });
    return this.withGitHubCheckout(location, apiSha, async (checkout) => {
      const located = this.locateGitHubPlugin(checkout.repoRoot, location);
      const result = await this.installFromDirectory(located.root, {
        fallbackName: located.fallbackName,
        source: this.buildGitHubSource(location, located, apiSha ?? checkout.archiveSha),
      });
      log(
        `[PluginRuntime] GitHub install completed: ${result.plugin.name} (${result.plugin.pluginId}) from ${location.owner}/${location.repo}@${result.plugin.source?.commitSha ?? '?'}`
      );
      return this.withSkippedSymlinks(result, checkout.skippedSymlinks);
    });
  }

  /**
   * Bring a plugin installed from GitHub to the newest commit of its ref.
   * Asks GitHub for the commit first and downloads nothing when it is the
   * installed one. The install date and the user's switches are kept; a
   * component that is new gets the install default (hooks and MCP off).
   */
  async updateFromGitHub(pluginId: string): Promise<PluginGitHubUpdateResult> {
    const stored = pluginRegistryStore.get(pluginId);
    if (!stored) {
      throw new PluginGitHubFailure('pluginNotFound', pluginId);
    }
    const plugin = this.normalizeInstalledPlugin(stored);
    const location = this.locationFromSource(plugin.source);
    if (!location) {
      throw new PluginGitHubFailure('notFromGitHub', plugin.name);
    }
    const previousSha = plugin.source?.commitSha;
    log(
      `[PluginRuntime] GitHub update requested: ${plugin.name} (${pluginId}) from ${location.owner}/${location.repo}@${previousSha ?? '?'}`
    );

    const apiSha = await resolveCommitSha(location, { fetchFn: this.fetchFn });
    if (apiSha && apiSha === previousSha) {
      log(`[PluginRuntime] GitHub update: ${plugin.name} is up to date (${apiSha})`);
      return { status: 'upToDate', plugin };
    }

    return this.withGitHubCheckout(location, apiSha, async (checkout) => {
      const commitSha = apiSha ?? checkout.archiveSha;
      if (commitSha && commitSha === previousSha) {
        log(`[PluginRuntime] GitHub update: ${plugin.name} is up to date (${commitSha})`);
        return { status: 'upToDate', plugin };
      }
      const located = this.locateGitHubPlugin(checkout.repoRoot, location);
      const result = await this.installFromDirectory(located.root, {
        fallbackName: located.fallbackName,
        source: this.buildGitHubSource(location, located, commitSha),
        preserve: plugin,
      });
      log(
        `[PluginRuntime] GitHub update completed: ${result.plugin.name} ${previousSha ?? '?'} -> ${commitSha ?? '?'}`
      );
      return {
        status: 'updated',
        previousCommitSha: previousSha,
        ...this.withSkippedSymlinks(result, checkout.skippedSymlinks),
      };
    });
  }

  /**
   * Download the repository at `apiSha` (or at its ref when GitHub gave no
   * commit), extract it into a fresh temp folder and hand the repository root
   * to `work`. The temp folder is removed whatever happens.
   */
  private async withGitHubCheckout<T>(
    location: GitHubPluginLocation,
    apiSha: string | null,
    work: (checkout: {
      repoRoot: string;
      archiveSha?: string;
      skippedSymlinks: string[];
    }) => Promise<T>
  ): Promise<T> {
    // Not `cowork-plugin-`: the archive import's cleanup test counts that prefix.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqowe-plugin-github-'));
    try {
      const archiveFile = path.join(tempDir, 'repository.zip');
      const extractDir = path.join(tempDir, 'repository');
      fs.mkdirSync(extractDir);
      await downloadGitHubArchive(location, apiSha ?? location.ref ?? 'HEAD', archiveFile, {
        fetchFn: this.fetchFn,
      });

      let extraction: ZipExtractionResult;
      try {
        extraction = await this.extractZipSafe(archiveFile, extractDir);
      } catch (error) {
        throw new PluginGitHubFailure('archiveInvalid', undefined, error);
      }

      // A GitHub archive wraps the tree in one `<repo>-<ref>/` folder.
      const topDir = this.findSingleTopDirectory(extractDir);
      const repoRoot = topDir ?? extractDir;
      return await work({
        repoRoot,
        archiveSha: isCommitSha(extraction.comment) ? extraction.comment : undefined,
        skippedSymlinks: this.stripTopFolder(
          extraction.skippedSymlinks,
          topDir ? path.basename(topDir) : undefined
        ),
      });
    } finally {
      try {
        await this.removePathWithRetries(tempDir);
      } catch (cleanupErr) {
        logError(`[PluginRuntime] Failed to clean up temp directory: ${tempDir}`, cleanupErr);
      }
    }
  }

  /**
   * Safely extract a zip/plugin archive to a target directory.
   * Uses yauzl directly for full control: validates each entry before writing,
   * skips symbolic links (never created, never followed — and reported),
   * enforces path traversal protection, and counts actual bytes.
   */
  private async extractZipSafe(
    archivePath: string,
    targetDir: string
  ): Promise<ZipExtractionResult> {
    const absoluteArchive = path.resolve(archivePath);
    const absoluteTarget = path.resolve(targetDir);

    const MAX_ENTRIES = 10000;
    const MAX_TOTAL_SIZE = 500 * 1024 * 1024; // 500 MB
    const timeoutMs = this.extractTimeoutMs;

    const zipFile = await this.openZip(absoluteArchive);

    let entryCount = 0;
    let totalBytesWritten = 0;
    const skippedSymlinks: string[] = [];

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        // The stream currently being written, so a timeout can stop it.
        let activeRead: { destroy: () => void } | null = null;
        let activeWrite: fs.WriteStream | null = null;

        const safeReject = (err: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          try {
            zipFile.close();
          } catch {
            /* already closed */
          }
          reject(err);
        };

        const safeResolve = () => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          resolve();
        };

        // A stalled stream must end in an error, never in an endless wait: yauzl
        // 2.10 stalled on any entry larger than ~64 KB compressed (fixed by 3.x),
        // and the spinner in Settings had nothing to stop it.
        const deadline = setTimeout(() => {
          try {
            activeRead?.destroy();
            activeWrite?.destroy();
          } catch {
            /* best effort */
          }
          safeReject(
            new Error(`Archive extraction did not finish within ${timeoutMs / 1000} s. Aborting.`)
          );
        }, timeoutMs);

        zipFile.on('error', safeReject);

        zipFile.on('entry', (entry: import('yauzl').Entry) => {
          if (settled) return;

          try {
            entryCount++;
            if (entryCount > MAX_ENTRIES) {
              return safeReject(
                new Error(`Archive contains too many entries (>${MAX_ENTRIES}). Aborting.`)
              );
            }

            const fileName = entry.fileName;

            // Reject absolute paths
            if (fileName.startsWith('/')) {
              return safeReject(
                new Error(`Unsafe archive entry (absolute path): ${fileName}. Aborting.`)
              );
            }

            // Reject path traversal
            const normalized = path.normalize(fileName);
            if (normalized.startsWith('..') || normalized.includes(`${path.sep}..`)) {
              return safeReject(
                new Error(`Unsafe archive entry (path traversal): ${fileName}. Aborting.`)
              );
            }

            // Skip symlinks: external file attributes encode Unix mode in upper 16 bits.
            // Nothing is written for the entry, so nothing can be reached through it.
            const externalAttrs = entry.externalFileAttributes;
            const unixMode = (externalAttrs >>> 16) & 0xffff;
            const S_IFLNK = 0o120000;
            if (unixMode !== 0 && (unixMode & 0o170000) === S_IFLNK) {
              skippedSymlinks.push(fileName);
              zipFile.readEntry();
              return;
            }

            const destPath = path.join(absoluteTarget, fileName);

            // Verify resolved path is within target directory
            const resolvedDest = path.resolve(destPath);
            if (
              !resolvedDest.startsWith(absoluteTarget + path.sep) &&
              resolvedDest !== absoluteTarget
            ) {
              return safeReject(
                new Error(`Archive entry escapes target directory: ${fileName}. Aborting.`)
              );
            }

            // Directory entry
            if (fileName.endsWith('/')) {
              fs.mkdirSync(destPath, { recursive: true });
              zipFile.readEntry();
              return;
            }

            // File entry — check projected size
            if (totalBytesWritten + entry.uncompressedSize > MAX_TOTAL_SIZE) {
              return safeReject(
                new Error(`Archive uncompressed size exceeds ${MAX_TOTAL_SIZE} bytes. Aborting.`)
              );
            }

            // Ensure parent directory exists (and validate it's not a symlink)
            const parentDir = path.dirname(destPath);
            fs.mkdirSync(parentDir, { recursive: true });
            const parentStat = fs.lstatSync(parentDir);
            if (parentStat.isSymbolicLink()) {
              return safeReject(
                new Error(`Parent directory is a symlink for entry: ${fileName}. Aborting.`)
              );
            }

            zipFile.openReadStream(entry, (err, readStream) => {
              if (settled) return;
              if (err) return safeReject(err);
              if (!readStream) return safeReject(new Error(`Failed to read entry: ${fileName}`));

              const writeStream = fs.createWriteStream(destPath);
              activeRead = readStream;
              activeWrite = writeStream;

              readStream.on('data', (chunk: Buffer) => {
                if (settled) return;
                totalBytesWritten += chunk.length;
                if (totalBytesWritten > MAX_TOTAL_SIZE) {
                  readStream.destroy();
                  writeStream.destroy();
                  safeReject(
                    new Error(`Archive extraction exceeded ${MAX_TOTAL_SIZE} bytes. Aborting.`)
                  );
                }
              });

              readStream.pipe(writeStream);

              writeStream.on('finish', () => {
                if (!settled) zipFile.readEntry();
              });

              writeStream.on('error', (writeErr) => safeReject(writeErr));
              readStream.on('error', (readErr) => safeReject(readErr));
            });
          } catch (err) {
            safeReject(err instanceof Error ? err : new Error(String(err)));
          }
        });

        zipFile.on('end', safeResolve);

        zipFile.readEntry();
      });
    } finally {
      // Ensure zipFile is closed even on unexpected errors
      try {
        zipFile.close();
      } catch {
        // Already closed
      }
    }

    if (skippedSymlinks.length > 0) {
      log(
        `[PluginRuntime] Skipped ${skippedSymlinks.length} symbolic link(s) in ${absoluteArchive}: ${skippedSymlinks.join(', ')}`
      );
    }
    return {
      comment: typeof zipFile.comment === 'string' ? zipFile.comment.trim() : '',
      skippedSymlinks,
    };
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<PluginToggleResult> {
    const plugin = pluginRegistryStore.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`);
    }

    const normalized = this.normalizeInstalledPlugin(plugin);
    normalized.enabled = enabled;
    normalized.updatedAt = Date.now();
    pluginRegistryStore.save(normalized);

    await this.materializeRuntime(pluginId);
    const updated = pluginRegistryStore.get(pluginId);
    if (!updated) {
      throw new Error(`Plugin not found after update: ${pluginId}`);
    }
    log(`[PluginRuntime] Plugin toggled: ${updated.name} (${pluginId}) enabled=${enabled}`);
    return {
      success: true,
      plugin: this.normalizeInstalledPlugin(updated),
    };
  }

  async setComponentEnabled(
    pluginId: string,
    component: PluginComponentKind,
    enabled: boolean
  ): Promise<PluginToggleResult> {
    const plugin = pluginRegistryStore.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`);
    }

    const normalized = this.normalizeInstalledPlugin(plugin);
    const hasComponent = normalized.componentCounts[component] > 0;
    normalized.componentsEnabled[component] = enabled && hasComponent;
    normalized.updatedAt = Date.now();
    pluginRegistryStore.save(normalized);

    await this.materializeRuntime(pluginId);
    const updated = pluginRegistryStore.get(pluginId);
    if (!updated) {
      throw new Error(`Plugin not found after update: ${pluginId}`);
    }
    log(
      `[PluginRuntime] Plugin component toggled: ${updated.name} (${pluginId}) component=${component} enabled=${normalized.componentsEnabled[component]} available=${hasComponent}`
    );
    return {
      success: true,
      plugin: this.normalizeInstalledPlugin(updated),
    };
  }

  async uninstall(pluginId: string): Promise<{ success: boolean }> {
    log(`[PluginRuntime] Uninstall requested: ${pluginId}`);
    const plugin = pluginRegistryStore.get(pluginId);
    if (!plugin) {
      log(`[PluginRuntime] Uninstall skipped: plugin not found (${pluginId})`);
      return { success: false };
    }

    log(
      `[PluginRuntime] Removing plugin files: ${plugin.name} (${pluginId}), source=${plugin.sourcePath}, runtime=${plugin.runtimePath}`
    );
    await this.removePathWithRetries(plugin.sourcePath);
    await this.removePathWithRetries(plugin.runtimePath);
    const success = pluginRegistryStore.delete(pluginId);
    log(`[PluginRuntime] Uninstall completed: ${plugin.name} (${pluginId}) success=${success}`);
    return { success };
  }

  async getEnabledRuntimePlugins(): Promise<InstalledPlugin[]> {
    const plugins = this.listInstalled().filter(
      (plugin) =>
        plugin.enabled &&
        this.hasAnyEnabledComponent(plugin.componentsEnabled, plugin.componentCounts)
    );

    const ready: InstalledPlugin[] = [];
    for (const plugin of plugins) {
      if (!fs.existsSync(plugin.runtimePath)) {
        await this.materializeRuntime(plugin.pluginId);
      }
      if (fs.existsSync(plugin.runtimePath)) {
        ready.push(plugin);
      }
    }
    return ready;
  }

  private static async defaultCommandRunner(
    command: string,
    args: string[]
  ): Promise<CommandOutput> {
    // Enrich PATH for packaged app (same strategy as agent-runner)
    const env = { ...process.env };
    if (process.platform === 'darwin' || process.platform === 'linux') {
      try {
        const userShell = getDefaultShell();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { execSync } = require('child_process');
        const shellOutput = execSync(`${userShell} -l -c "echo $PATH"`, {
          encoding: 'utf-8',
          timeout: 3000,
        }).trim();
        if (shellOutput) env.PATH = shellOutput;
      } catch {
        /* use process.env.PATH */
      }
    } else if (process.platform === 'win32') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { execSync } = require('child_process');
        const winPath = execSync(
          "powershell.exe -NoProfile -Command \"[Environment]::GetEnvironmentVariable('Path', 'User') + ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine')\"",
          { encoding: 'utf-8', timeout: 5000 }
        ).trim();
        if (winPath) {
          const winPaths = winPath.split(';').filter((p: string) => p.trim());
          const currentPaths = (env.PATH || '').split(';').filter((p: string) => p.trim());
          const allPaths = [...winPaths];
          for (const p of currentPaths) {
            if (!allPaths.some((ep) => ep.toLowerCase() === p.toLowerCase())) {
              allPaths.push(p);
            }
          }
          env.PATH = allPaths.join(';');
        }
      } catch {
        /* use process.env.PATH */
      }
    }
    const result = await execFileAsync(command, args, {
      env,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  private async installWithClaudeCli(pluginId: string): Promise<void> {
    log(`[PluginRuntime] Running Claude CLI install: ${pluginId}`);
    try {
      await this.commandRunner('claude', ['plugin', 'install', pluginId]);
      log(`[PluginRuntime] Claude CLI install succeeded: ${pluginId}`);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT') {
        throw new Error(
          'Failed to install plugin: claude command not found. Please install Claude Code CLI first.'
        );
      }

      const stderr = (error as { stderr?: string }).stderr?.trim();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to install plugin via Claude CLI: ${stderr || message}`);
    }
  }

  private async resolveInstallPathFromCli(pluginId: string): Promise<string> {
    const installed = await this.listInstalledPluginsFromCli();
    log(`[PluginRuntime] Installed plugins reported by Claude CLI: ${installed.length}`);
    const record =
      installed.find((plugin) => plugin.id === pluginId) ??
      installed.find((plugin) => plugin.id?.toLowerCase() === pluginId.toLowerCase());

    if (!record?.installPath) {
      const availableIds = installed
        .map((plugin) => plugin.id)
        .filter((id): id is string => Boolean(id));
      log(
        `[PluginRuntime] installPath resolution failed for ${pluginId}, availableIds=${JSON.stringify(availableIds)}`
      );
      throw new Error(`Failed to install plugin: installPath not found for ${pluginId}`);
    }

    const pluginRootPath = record.installPath;
    log(`[PluginRuntime] Resolved installPath from Claude CLI: ${pluginId} -> ${pluginRootPath}`);
    if (!fs.existsSync(pluginRootPath) || !fs.statSync(pluginRootPath).isDirectory()) {
      throw new Error(
        `Failed to install plugin: installPath is not a directory (${pluginRootPath})`
      );
    }

    return pluginRootPath;
  }

  private async listInstalledPluginsFromCli(): Promise<ClaudeInstalledPluginRecord[]> {
    let commandOutput: CommandOutput;
    try {
      commandOutput = await this.commandRunner('claude', ['plugin', 'list', '--json']);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT') {
        throw new Error('Failed to read installed plugins: claude command not found.');
      }

      const stderr = (error as { stderr?: string }).stderr?.trim();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read installed plugins from Claude CLI: ${stderr || message}`);
    }

    let parsed: ClaudePluginListOutput | ClaudeInstalledPluginRecord[];
    try {
      parsed = JSON.parse(commandOutput.stdout) as
        | ClaudePluginListOutput
        | ClaudeInstalledPluginRecord[];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse Claude plugin list JSON: ${message}`);
    }

    if (Array.isArray(parsed)) {
      return parsed;
    }

    return Array.isArray(parsed.installed) ? parsed.installed : [];
  }

  private extractPluginId(installCommand: string | undefined): string | undefined {
    if (!installCommand) {
      return undefined;
    }

    const match = installCommand.match(/^claude plugin (?:install|add)\s+([^\s"'`]+)/i);
    return match?.[1];
  }

  private getCatalogPluginId(plugin: PluginCatalogItemV2): string | undefined {
    return plugin.pluginId ?? this.extractPluginId(plugin.installCommand);
  }

  private resolveCatalogPlugin(
    catalog: PluginCatalogItemV2[],
    loweredRequested: string
  ): PluginCatalogItemV2 | null {
    const byExactPluginId = catalog.find(
      (plugin) => this.getCatalogPluginId(plugin)?.toLowerCase() === loweredRequested
    );
    if (byExactPluginId) {
      return byExactPluginId;
    }

    const byBarePluginId = catalog.filter((plugin) => {
      const pluginId = this.getCatalogPluginId(plugin);
      return pluginId?.split('@')[0]?.toLowerCase() === loweredRequested;
    });
    if (byBarePluginId.length === 1) {
      return byBarePluginId[0];
    }
    if (byBarePluginId.length > 1) {
      const candidates = byBarePluginId
        .map((plugin) => this.getCatalogPluginId(plugin))
        .filter((value): value is string => Boolean(value));
      throw new Error(
        `Multiple plugins matched this id prefix. Please install using full plugin id: ${candidates.join(', ')}`
      );
    }

    const byName = catalog.filter((plugin) => plugin.name.toLowerCase() === loweredRequested);
    if (byName.length === 1) {
      return byName[0];
    }
    if (byName.length > 1) {
      const candidates = byName
        .map((plugin) => this.getCatalogPluginId(plugin))
        .filter((value): value is string => Boolean(value));
      throw new Error(
        `Multiple plugins share this name. Please install by plugin id: ${candidates.join(', ')}`
      );
    }

    return null;
  }

  private async materializeRuntime(pluginId: string): Promise<void> {
    const plugin = pluginRegistryStore.get(pluginId);
    if (!plugin) {
      return;
    }

    await this.removePathWithRetries(plugin.runtimePath);

    const active =
      plugin.enabled &&
      this.hasAnyEnabledComponent(plugin.componentsEnabled, plugin.componentCounts);
    if (!active) {
      return;
    }

    this.copyDirectory(plugin.sourcePath, plugin.runtimePath);

    const sourceManifest = this.readManifest(plugin.sourcePath);
    const runtimeManifest = this.buildRuntimeManifest(plugin, sourceManifest);
    await this.pruneDisabledComponents(plugin, sourceManifest);
    this.writeRuntimeManifest(plugin.runtimePath, runtimeManifest);

    log(`[PluginRuntime] Materialized runtime plugin: ${plugin.name} (${plugin.pluginId})`);
  }

  private buildRuntimeManifest(
    plugin: InstalledPlugin,
    sourceManifest: PluginManifest | null
  ): PluginManifest {
    const metadata: PluginManifest = sourceManifest ? { ...sourceManifest } : {};
    metadata.name = plugin.name;
    metadata.version = plugin.version ?? metadata.version ?? '0.1.0';
    metadata.description = plugin.description ?? metadata.description;
    if (plugin.authorName && !metadata.author) {
      metadata.author = plugin.authorName;
    }

    if (!this.isRuntimeComponentEnabled(plugin, 'commands')) {
      delete metadata.commands;
    }
    if (!this.isRuntimeComponentEnabled(plugin, 'agents')) {
      delete metadata.agents;
    }
    if (!this.isRuntimeComponentEnabled(plugin, 'hooks')) {
      delete metadata.hooks;
    }
    if (!this.isRuntimeComponentEnabled(plugin, 'mcp')) {
      delete metadata.mcpServers;
    }

    return metadata;
  }

  private async pruneDisabledComponents(
    plugin: InstalledPlugin,
    sourceManifest: PluginManifest | null
  ): Promise<void> {
    if (!this.isRuntimeComponentEnabled(plugin, 'skills')) {
      await this.removeRelativePath(plugin.runtimePath, './skills');
    }

    if (!this.isRuntimeComponentEnabled(plugin, 'commands')) {
      for (const componentPath of this.resolveComponentPaths(sourceManifest?.commands, [
        './commands',
      ])) {
        await this.removeRelativePath(plugin.runtimePath, componentPath);
      }
    }

    if (!this.isRuntimeComponentEnabled(plugin, 'agents')) {
      for (const componentPath of this.resolveComponentPaths(sourceManifest?.agents, [
        './agents',
      ])) {
        await this.removeRelativePath(plugin.runtimePath, componentPath);
      }
    }

    if (!this.isRuntimeComponentEnabled(plugin, 'hooks')) {
      if (typeof sourceManifest?.hooks === 'string') {
        await this.removeRelativePath(plugin.runtimePath, sourceManifest.hooks);
      } else {
        await this.removeRelativePath(plugin.runtimePath, './hooks/hooks.json');
      }
      await this.removeRelativePath(plugin.runtimePath, './hooks');
      await this.removeRelativePath(plugin.runtimePath, './hooks-handlers');
    }

    if (!this.isRuntimeComponentEnabled(plugin, 'mcp')) {
      if (typeof sourceManifest?.mcpServers === 'string') {
        await this.removeRelativePath(plugin.runtimePath, sourceManifest.mcpServers);
      } else {
        await this.removeRelativePath(plugin.runtimePath, './.mcp.json');
      }
      await this.removeRelativePath(plugin.runtimePath, './mcp');
    }
  }

  private writeRuntimeManifest(runtimeRootPath: string, manifest: PluginManifest): void {
    const manifestDir = path.join(runtimeRootPath, '.claude-plugin');
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, 'plugin.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  private detectComponentCounts(
    pluginRootPath: string,
    manifest: PluginManifest | null
  ): PluginComponentCounts {
    const counts = cloneCounts(EMPTY_COUNTS);
    counts.skills = this.countSkills(pluginRootPath);
    counts.commands = this.countMarkdownComponent(
      pluginRootPath,
      this.resolveComponentPaths(manifest?.commands, ['./commands'])
    );
    counts.agents = this.countMarkdownComponent(
      pluginRootPath,
      this.resolveComponentPaths(manifest?.agents, ['./agents'])
    );
    counts.hooks = this.countHooks(pluginRootPath, manifest);
    counts.mcp = this.countMcp(pluginRootPath, manifest);
    return counts;
  }

  private countSkills(pluginRootPath: string): number {
    const skillsRoot = path.join(pluginRootPath, 'skills');
    if (!fs.existsSync(skillsRoot) || !fs.statSync(skillsRoot).isDirectory()) {
      return 0;
    }
    const entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
    return entries.reduce((count, entry) => {
      if (!entry.isDirectory()) {
        return count;
      }
      const skillFile = path.join(skillsRoot, entry.name, 'SKILL.md');
      return fs.existsSync(skillFile) ? count + 1 : count;
    }, 0);
  }

  private countMarkdownComponent(pluginRootPath: string, relativePaths: string[]): number {
    const uniqueFiles = new Set<string>();
    for (const relativePath of relativePaths) {
      const absolutePath = this.resolveSafePath(pluginRootPath, relativePath);
      if (!absolutePath || !fs.existsSync(absolutePath)) {
        continue;
      }
      this.collectMarkdownFiles(absolutePath, uniqueFiles);
    }
    return uniqueFiles.size;
  }

  private countHooks(pluginRootPath: string, manifest: PluginManifest | null): number {
    if (manifest?.hooks && typeof manifest.hooks === 'object') {
      return 1;
    }

    const hookPaths =
      typeof manifest?.hooks === 'string' ? [manifest.hooks] : ['./hooks/hooks.json'];

    for (const hookPath of hookPaths) {
      const absolutePath = this.resolveSafePath(pluginRootPath, hookPath);
      if (absolutePath && fs.existsSync(absolutePath)) {
        return 1;
      }
    }
    return 0;
  }

  private countMcp(pluginRootPath: string, manifest: PluginManifest | null): number {
    if (manifest?.mcpServers && typeof manifest.mcpServers === 'object') {
      return 1;
    }

    const mcpPaths =
      typeof manifest?.mcpServers === 'string' ? [manifest.mcpServers] : ['./.mcp.json'];

    for (const mcpPath of mcpPaths) {
      const absolutePath = this.resolveSafePath(pluginRootPath, mcpPath);
      if (absolutePath && fs.existsSync(absolutePath)) {
        return 1;
      }
    }
    return 0;
  }

  private getDefaultComponentState(
    componentCounts: PluginComponentCounts
  ): PluginComponentEnabledState {
    return {
      skills: componentCounts.skills > 0,
      commands: componentCounts.commands > 0,
      agents: componentCounts.agents > 0,
      hooks: false,
      mcp: false,
    };
  }

  private hasAnyEnabledComponent(
    componentsEnabled: PluginComponentEnabledState,
    componentCounts: PluginComponentCounts
  ): boolean {
    return (Object.keys(componentsEnabled) as PluginComponentKind[]).some(
      (component) => componentsEnabled[component] && componentCounts[component] > 0
    );
  }

  private isRuntimeComponentEnabled(
    plugin: InstalledPlugin,
    component: PluginComponentKind
  ): boolean {
    return plugin.componentsEnabled[component] && plugin.componentCounts[component] > 0;
  }

  private resolveComponentPaths(
    value: string | string[] | undefined,
    fallback: string[]
  ): string[] {
    if (!value) {
      return fallback;
    }
    return Array.isArray(value) ? value : [value];
  }

  private resolveSafePath(rootPath: string, relativePath: string): string | null {
    const normalized = relativePath.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normalized || normalized.startsWith('/')) {
      return null;
    }
    const resolved = path.resolve(rootPath, normalized);
    if (!isPathWithinRoot(resolved, rootPath)) {
      return null;
    }
    return resolved;
  }

  private collectMarkdownFiles(targetPath: string, output: Set<string>): void {
    const stat = fs.statSync(targetPath);
    if (stat.isFile()) {
      if (targetPath.toLowerCase().endsWith('.md')) {
        output.add(targetPath);
      }
      return;
    }

    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    for (const entry of entries) {
      this.collectMarkdownFiles(path.join(targetPath, entry.name), output);
    }
  }

  private async removeRelativePath(rootPath: string, relativePath: string): Promise<void> {
    const absolutePath = this.resolveSafePath(rootPath, relativePath);
    if (!absolutePath) {
      return;
    }
    await this.removePathWithRetries(absolutePath);
  }

  private async removePathWithRetries(targetPath: string): Promise<void> {
    try {
      await this.ensurePathRemoved(targetPath);
    } catch (error) {
      if (!fs.existsSync(targetPath)) {
        return;
      }

      const movedPath = this.movePathToTrash(targetPath);
      if (!movedPath) {
        throw error;
      }

      try {
        fs.rmSync(movedPath, { recursive: true, force: true });
      } catch (cleanupError) {
        logError(
          `[PluginRuntime] Failed to fully delete moved-aside path: ${movedPath}`,
          cleanupError
        );
      }
    }
  }

  private async ensurePathRemoved(targetPath: string): Promise<void> {
    await withRetry(
      async () => {
        if (!fs.existsSync(targetPath)) {
          return;
        }

        fs.rmSync(targetPath, { recursive: true, force: true });

        if (fs.existsSync(targetPath)) {
          const error = new Error(`Path still exists after removal: ${targetPath}`) as Error & {
            code?: string;
          };
          error.code = 'ENOTEMPTY';
          throw error;
        }
      },
      {
        maxRetries: 5,
        delayMs: 25,
        backoffMultiplier: 2,
        shouldRetry: (error) => {
          const code = (error as Error & { code?: string }).code;
          return code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY';
        },
      }
    );
  }

  private movePathToTrash(targetPath: string): string | null {
    if (!fs.existsSync(targetPath)) {
      return null;
    }

    try {
      const trashRoot = path.join(this.getPluginsRootPath(), '.trash');
      fs.mkdirSync(trashRoot, { recursive: true });

      const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const trashPath = path.join(trashRoot, `${path.basename(targetPath)}-${uniqueSuffix}`);
      fs.renameSync(targetPath, trashPath);
      return trashPath;
    } catch (error) {
      logError(`[PluginRuntime] Failed to move path to trash: ${targetPath}`, error);
      return null;
    }
  }

  private copyDirectory(sourcePath: string, targetPath: string): void {
    if (!fs.existsSync(targetPath)) {
      fs.mkdirSync(targetPath, { recursive: true });
    }

    const entries = fs.readdirSync(sourcePath, { withFileTypes: true });
    for (const entry of entries) {
      const sourceEntryPath = path.join(sourcePath, entry.name);
      const targetEntryPath = path.join(targetPath, entry.name);
      if (entry.isDirectory()) {
        this.copyDirectory(sourceEntryPath, targetEntryPath);
      } else if (entry.isSymbolicLink()) {
        // Validate symlink target is within allowed directory
        const linkTarget = fs.readlinkSync(sourceEntryPath);
        const resolvedTarget = path.resolve(path.dirname(sourceEntryPath), linkTarget);
        if (!isPathWithinRoot(resolvedTarget, sourcePath)) {
          throw new Error(`Symlink target outside allowed directory: ${resolvedTarget}`);
        }
        fs.symlinkSync(linkTarget, targetEntryPath);
      } else {
        fs.copyFileSync(sourceEntryPath, targetEntryPath);
      }
    }
  }

  private listSkillNames(pluginRootPath: string): string[] {
    const skillsRoot = path.join(pluginRootPath, 'skills');
    if (!fs.existsSync(skillsRoot) || !fs.statSync(skillsRoot).isDirectory()) {
      return [];
    }
    const entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skillFile = path.join(skillsRoot, entry.name, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        names.push(entry.name);
      }
    }
    return names.sort((a, b) => a.localeCompare(b));
  }

  private readManifest(pluginRootPath: string): PluginManifest | null {
    const manifestPath = path.join(pluginRootPath, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(manifestPath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PluginManifest;
    } catch (error) {
      logError(`[PluginRuntime] Failed to parse plugin manifest: ${manifestPath}`, error);
      return null;
    }
  }

  /**
   * Detect the orchestrator skill within a plugin's skills directory.
   * Scans SKILL.md frontmatter descriptions for orchestrator keywords.
   * Returns:
   *   - string: orchestrator skill name found
   *   - null: scan completed successfully, no orchestrator found
   *   - undefined: scan failed due to filesystem error (caller should retry later)
   */
  private detectOrchestrator(pluginRootPath: string): string | null | undefined {
    try {
      // First verify the plugin root exists — if not, this is a missing/moved plugin
      let rootStat: fs.Stats;
      try {
        rootStat = fs.statSync(pluginRootPath);
      } catch (err) {
        // Plugin root inaccessible — signal scan failure for retry
        logError(`[PluginRuntime] Cannot access plugin root: ${pluginRootPath}`, err);
        return undefined;
      }
      if (!rootStat.isDirectory()) return undefined;

      const skillsDir = path.join(pluginRootPath, 'skills');

      let stat: fs.Stats;
      try {
        stat = fs.statSync(skillsDir);
      } catch (err) {
        // ENOENT = skills dir doesn't exist within a valid plugin — no orchestrator
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        // Other errors (EACCES, EIO, etc.) = scan failure
        logError(`[PluginRuntime] Cannot access skills dir: ${skillsDir}`, err);
        return undefined;
      }

      if (!stat.isDirectory()) return null;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      } catch (err) {
        logError(`[PluginRuntime] Cannot read skills dir: ${skillsDir}`, err);
        return undefined;
      }

      // Sort for deterministic selection when multiple candidates exist
      const sortedEntries = entries
        .filter((e) => e.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of sortedEntries) {
        const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');

        let content: string;
        try {
          content = fs.readFileSync(skillMd, 'utf8');
        } catch {
          // Missing or unreadable SKILL.md — skip this skill, continue scanning
          continue;
        }

        const frontmatter = this.extractFrontmatter(content);
        if (
          frontmatter?.description &&
          /orchestrat|coordinat|delegates?\s+to/i.test(frontmatter.description)
        ) {
          log(`[PluginRuntime] Detected orchestrator skill: ${entry.name} in ${pluginRootPath}`);
          return entry.name;
        }
      }
      return null;
    } catch (error) {
      // Unexpected error — treat as scan failure
      logError(
        `[PluginRuntime] Unexpected error scanning for orchestrator in ${pluginRootPath}`,
        error
      );
      return undefined;
    }
  }

  /**
   * Extract YAML-like frontmatter from a SKILL.md file content.
   * Returns parsed key-value pairs from the --- delimited block.
   * Supports single-line values and multiline folded/literal scalars (> or |).
   */
  private extractFrontmatter(content: string): Record<string, string> | null {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return null;

    const lines = match[1].split('\n');
    const result: Record<string, string> = {};
    let currentKey = '';
    let currentValue = '';
    let isMultiline = false;

    const commitEntry = () => {
      if (currentKey) {
        result[currentKey] = currentValue.trim();
      }
    };

    for (const line of lines) {
      // Check if this is a new key-value pair (non-indented, has colon)
      const keyMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)/);

      if (keyMatch && !isMultiline) {
        commitEntry();
        currentKey = keyMatch[1];
        let value = keyMatch[2].trim();

        // Check for multiline indicators
        if (value === '>' || value === '|' || value === '>-' || value === '|-') {
          isMultiline = true;
          currentValue = '';
          continue;
        }

        // Strip surrounding quotes if present
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        currentValue = value;
        isMultiline = false;
      } else if (isMultiline || (currentKey && /^\s+/.test(line))) {
        // Continuation line for multiline value (indented)
        if (/^\s+/.test(line)) {
          isMultiline = true;
          currentValue += (currentValue ? ' ' : '') + line.trim();
        } else if (line.trim() === '') {
          // Empty line in multiline — add space separator
          currentValue += ' ';
        } else {
          // Non-indented, non-empty line that isn't a key — end multiline
          isMultiline = false;
          commitEntry();
          currentKey = '';
          currentValue = '';
        }
      }
    }

    commitEntry();
    return Object.keys(result).length > 0 ? result : null;
  }

  /**
   * Backfill orchestrator detection for all installed plugins that haven't
   * been scanned yet. Called once on service initialization.
   * Plugins with orchestratorSkill === null have already been scanned (no orchestrator).
   * Plugins with orchestratorSkill === undefined have never been scanned.
   * Best-effort: errors are logged but never crash app startup.
   */
  backfillOrchestrators(): void {
    try {
      const plugins = pluginRegistryStore.list();
      for (const plugin of plugins) {
        // Skip if already scanned (either found an orchestrator or explicitly set to null)
        if (plugin.orchestratorSkill !== undefined) continue;

        try {
          const orchestrator = this.detectOrchestrator(plugin.sourcePath);
          // undefined means scan failed — do not persist, allow retry on next startup
          if (orchestrator === undefined) continue;

          // Persist result (string or null) to avoid re-scanning
          plugin.orchestratorSkill = orchestrator;
          plugin.updatedAt = Date.now();
          pluginRegistryStore.save(plugin);
          if (orchestrator) {
            log(`[PluginRuntime] Backfilled orchestrator for ${plugin.name}: ${orchestrator}`);
          }
        } catch (error) {
          logError(`[PluginRuntime] Error backfilling orchestrator for ${plugin.name}`, error);
        }
      }
    } catch (error) {
      logError('[PluginRuntime] Error during orchestrator backfill', error);
    }
  }

  /**
   * The one folder an archive was packed in, ignoring macOS metadata entries
   * (`__MACOSX`, `._*`). Null when there is not exactly one.
   */
  private findSingleTopDirectory(dir: string): string | null {
    const meaningful = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => {
      const name = entry.name;
      return (
        entry.isDirectory() && name !== '__MACOSX' && name !== '.DS_Store' && !name.startsWith('._')
      );
    });
    return meaningful.length === 1 ? path.join(dir, meaningful[0].name) : null;
  }

  /** Archive entry names without the archive's top folder. */
  private stripTopFolder(entries: string[], topFolder: string | undefined): string[] {
    if (!topFolder) return entries;
    const prefix = `${topFolder}/`;
    return entries.map((entry) => (entry.startsWith(prefix) ? entry.slice(prefix.length) : entry));
  }

  private withSkippedSymlinks(
    result: PluginInstallResultV2,
    skippedSymlinks: string[]
  ): PluginInstallResultV2 {
    return skippedSymlinks.length > 0 ? { ...result, skippedSymlinks } : result;
  }

  /**
   * Find the plugin inside an extracted repository, at the folder the link
   * named: a `plugin.json`, else the single plugin of a `marketplace.json`,
   * else a `skills/` folder. Every path stays inside the repository.
   */
  private locateGitHubPlugin(
    repoRoot: string,
    location: GitHubPluginLocation
  ): LocatedGitHubPlugin {
    const realRepoRoot = fs.realpathSync(repoRoot);
    const start = location.path
      ? this.resolveInsideRepo(realRepoRoot, location.path, 'pathNotFound')
      : realRepoRoot;

    let root = start;
    let entryName: string | undefined;
    if (!fs.existsSync(path.join(start, '.claude-plugin', 'plugin.json'))) {
      const marketplacePath = path.join(start, '.claude-plugin', 'marketplace.json');
      if (fs.existsSync(marketplacePath)) {
        const fromMarketplace = this.resolveMarketplacePlugin(realRepoRoot, start, marketplacePath);
        root = fromMarketplace.root;
        entryName = fromMarketplace.name;
      } else if (this.countSkills(start) === 0) {
        throw new PluginGitHubFailure('noPlugin');
      }
    }

    const relative = path.relative(realRepoRoot, root).split(path.sep).join('/');
    const lastSegment = relative ? relative.split('/').pop() : undefined;
    return {
      root,
      relativePath: relative || undefined,
      fallbackName: entryName || lastSegment || location.repo,
    };
  }

  /** The single plugin a `marketplace.json` lists, when its files are in this repository. */
  private resolveMarketplacePlugin(
    realRepoRoot: string,
    marketplaceRoot: string,
    marketplacePath: string
  ): { root: string; name?: string } {
    let manifest: MarketplaceManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(marketplacePath, 'utf8')) as MarketplaceManifest;
    } catch (error) {
      logError(`[PluginRuntime] Failed to parse marketplace manifest: ${marketplacePath}`, error);
      throw new PluginGitHubFailure('noPlugin', 'marketplace.json');
    }

    const entries = Array.isArray(manifest?.plugins) ? manifest.plugins : [];
    if (entries.length === 0) {
      throw new PluginGitHubFailure('noPlugin', 'marketplace.json');
    }
    if (entries.length > 1) {
      const names = entries
        .map((entry) => (typeof entry?.name === 'string' ? entry.name : '?'))
        .join(', ');
      throw new PluginGitHubFailure('multiplePlugins', names);
    }

    const entry = entries[0];
    const name =
      typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined;
    const source = entry?.source;
    if (typeof source !== 'string') {
      const kind =
        source &&
        typeof source === 'object' &&
        typeof (source as { source?: unknown }).source === 'string'
          ? String((source as { source: string }).source)
          : 'unknown';
      throw new PluginGitHubFailure('unsupportedSource', kind);
    }

    // Claude Code's rules: `.` or `./…` from the marketplace root, or a bare
    // name under `metadata.pluginRoot`; never `..`, a backslash or an absolute path.
    let relative: string;
    if (source === '.' || source.startsWith('./')) {
      relative = source;
    } else if (
      !source.includes('/') &&
      typeof manifest.metadata?.pluginRoot === 'string' &&
      manifest.metadata.pluginRoot.trim()
    ) {
      relative = `${manifest.metadata.pluginRoot.trim()}/${source}`;
    } else {
      throw new PluginGitHubFailure('unsupportedSource', source);
    }
    const segments = relative.split('/').filter((segment) => segment !== '' && segment !== '.');
    if (segments.length === 0) {
      return { root: marketplaceRoot, name };
    }
    const subpath = normalizeRepoSubpath(segments);
    if (!subpath) {
      throw new PluginGitHubFailure('unsupportedSource', source);
    }
    const root = this.resolveInsideRepo(
      realRepoRoot,
      path.posix.join(
        path.relative(realRepoRoot, marketplaceRoot).split(path.sep).join('/'),
        subpath
      ),
      'noPlugin'
    );
    return { root, name };
  }

  /** An existing folder inside the repository, by its real path; `failure` otherwise. */
  private resolveInsideRepo(
    realRepoRoot: string,
    relativePath: string,
    failure: 'pathNotFound' | 'noPlugin'
  ): string {
    const subpath = normalizeRepoSubpath(relativePath.split('/'));
    if (!subpath) {
      throw new PluginGitHubFailure(failure, relativePath);
    }
    const candidate = path.resolve(realRepoRoot, ...subpath.split('/'));
    let real: string;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      throw new PluginGitHubFailure(failure, subpath);
    }
    if (!isPathWithinRoot(real, realRepoRoot) || !fs.statSync(real).isDirectory()) {
      throw new PluginGitHubFailure(failure, subpath);
    }
    return real;
  }

  private buildGitHubSource(
    location: GitHubPluginLocation,
    located: LocatedGitHubPlugin,
    commitSha: string | undefined | null
  ): PluginGitHubSource {
    return {
      type: 'github',
      owner: location.owner,
      repo: location.repo,
      ...(location.ref ? { ref: location.ref } : {}),
      ...(located.relativePath ? { path: located.relativePath } : {}),
      ...(isCommitSha(commitSha) ? { commitSha } : {}),
    };
  }

  /** The stored source as a location to fetch, or null when it is not a valid GitHub one. */
  private locationFromSource(source: InstalledPlugin['source']): GitHubPluginLocation | null {
    if (!source || source.type !== 'github') return null;
    if (!isValidGitHubOwner(source.owner) || !isValidGitHubRepoName(source.repo)) return null;
    if (source.ref !== undefined && !isValidGitRef(source.ref)) return null;
    if (
      source.path !== undefined &&
      (typeof source.path !== 'string' ||
        normalizeRepoSubpath(source.path.split('/')) !== source.path)
    ) {
      return null;
    }
    return {
      owner: source.owner,
      repo: source.repo,
      ...(source.ref ? { ref: source.ref } : {}),
      ...(source.path ? { path: source.path } : {}),
    };
  }

  private resolvePluginIdentity(
    manifest: PluginManifest | null,
    fallbackName: string
  ): { displayName: string; pluginId: string } {
    const manifestName = typeof manifest?.name === 'string' ? manifest.name.trim() : '';
    const displayName = manifestName || fallbackName;
    return { displayName, pluginId: this.sanitizePluginId(displayName) };
  }

  /**
   * Switches for an updated plugin: each component it already had keeps the
   * user's choice; a component that is new gets the install default.
   */
  private mergeComponentState(
    previous: InstalledPlugin,
    counts: PluginComponentCounts,
    defaults: PluginComponentEnabledState
  ): PluginComponentEnabledState {
    const merged = cloneComponentState(defaults);
    for (const component of Object.keys(merged) as PluginComponentKind[]) {
      if (previous.componentCounts[component] > 0) {
        merged[component] = previous.componentsEnabled[component] && counts[component] > 0;
      }
    }
    return merged;
  }

  private sanitizePluginId(name: string): string {
    const sanitized = name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return sanitized || `plugin-${Date.now()}`;
  }

  private resolveAuthorName(author: PluginManifest['author']): string | undefined {
    if (!author) {
      return undefined;
    }
    if (typeof author === 'string') {
      return author;
    }
    return author.name;
  }

  private normalizeInstalledPlugin(plugin: InstalledPlugin): InstalledPlugin {
    return {
      ...plugin,
      componentCounts: plugin.componentCounts
        ? cloneCounts(plugin.componentCounts)
        : cloneCounts(EMPTY_COUNTS),
      componentsEnabled: plugin.componentsEnabled
        ? cloneComponentState(plugin.componentsEnabled)
        : cloneComponentState(EMPTY_COMPONENT_STATE),
    };
  }

  private getPluginsRootPath(): string {
    return path.join(app.getPath('userData'), 'claude', 'plugins');
  }

  private getSourcePath(pluginId: string): string {
    return path.join(this.getPluginsRootPath(), 'source', pluginId);
  }

  private getRuntimePath(pluginId: string): string {
    return path.join(this.getPluginsRootPath(), 'runtime', pluginId);
  }
}
