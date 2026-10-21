/**
 * @module main/claude/pi-resource-loader
 *
 * Builds the pi `DefaultResourceLoader` for a new agent session — the SDK-only boundary
 * (ARCHITECTURE.md §4.1) applied to what pi loads from disk.
 *
 * Without a settings manager of its own, the loader makes a file-backed one,
 * `SettingsManager.create(cwd, agentDir)`, whose project trust defaults to on
 * (`projectTrusted ?? true` in pi-coding-agent/dist/core/settings-manager.js). For the
 * workspace the user opened, pi would then load `<workspace>/.pi/extensions/*` into this
 * process, install with npm the `packages` listed in `<workspace>/.pi/settings.json`, take
 * `<workspace>/.pi/SYSTEM.md` as the system prompt, and add skills from `.pi/skills` and
 * `.agents/skills` past the app's own skill settings. So the loader gets:
 *
 * - an in-memory settings manager with project trust off — no settings file is read, and
 *   nothing trust-gated is discovered in the workspace;
 * - `noExtensions` — no discovered extension loads, user-level ones included. Inline
 *   `extensionFactories` would still load; the app passes none.
 * - `noSkills` — pi discovers no skills of its own. It would otherwise add
 *   `<agentDir>/skills` (the runtime skills dir, unfiltered — so skills disabled for a
 *   session still loaded) and the user's `~/.agents/skills` (outside every skill setting
 *   of the app). Only `additionalSkillPaths` load: the list skill-paths.ts assembles.
 *
 * Design: docs/design/permission-gate-tool-call-event.md §2.
 */
import {
  DefaultResourceLoader,
  SettingsManager as PiSettingsManager,
} from '@earendil-works/pi-coding-agent';

export interface PiResourceLoaderOptions {
  cwd: string;
  agentDir: string;
  additionalSkillPaths: string[];
  appendSystemPrompt: string[] | undefined;
}

/** The options the loader is built with — exported so the boundary can be tested. */
export function piResourceLoaderOptions(options: PiResourceLoaderOptions) {
  return {
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: PiSettingsManager.inMemory({}, { projectTrusted: false }),
    noExtensions: true,
    noSkills: true,
    additionalSkillPaths: options.additionalSkillPaths,
    appendSystemPrompt: options.appendSystemPrompt,
    // App owns instruction-file discovery (D1): disable pi's native
    // AGENTS.md/CLAUDE.md auto-loading to prevent double-injection.
    // Confirmed from resource-loader.js (dist): noContextFiles=true only
    // gates the agentsFiles path (loadProjectContextFiles call) — it sets
    // agentsFiles:[] and leaves extensions, skills, prompts, themes, and
    // system-prompt discovery completely unaffected. Verified against the
    // installed package; see tests/workspace-system-prompt.test.ts for
    // the regression test that detects double-injection.
    noContextFiles: true,
  };
}

/** A loaded resource loader for a new session. */
export async function createPiResourceLoader(
  options: PiResourceLoaderOptions
): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader(piResourceLoaderOptions(options));
  await loader.reload();
  return loader;
}
