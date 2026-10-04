/**
 * The trusted-directories write zone in the pi extension: config files →
 * loader → write zone → engine → dialog mapping, for the bash tool and for the
 * `write` / `edit` tools (docs/design/trusted-directories.md).
 *
 * Nothing is stubbed except the UI dialog surface. Real JSON files in temporary
 * directories; the production loader, engine and mapper.
 *
 * SAFETY: these functions only DECIDE — no command or write is ever executed.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadBashRestrictions } from '../pi-extensions/bash-restrictions/config';
import {
  CHOICE_ALLOW,
  CHOICE_DENY,
  CHOICE_SUGGEST,
  resolveBashToolCall,
  resolveWriteToolCall,
  type BashCtx,
  type WriteZoneSession,
} from '../pi-extensions/bash-restrictions/extension';

let tmpHome: string;
let tmpProject: string;
let tmpOther: string;

beforeEach(() => {
  tmpHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'pi-zone-home-')));
  tmpProject = realpathSync.native(mkdtempSync(join(tmpdir(), 'pi-zone-proj-')));
  tmpOther = realpathSync.native(mkdtempSync(join(tmpdir(), 'pi-zone-other-')));
});

afterEach(() => {
  for (const dir of [tmpHome, tmpProject, tmpOther]) rmSync(dir, { recursive: true, force: true });
});

function writeGlobal(content: unknown): void {
  const dir = join(tmpHome, '.pi', 'agent');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bash-restrictions.json'), JSON.stringify(content));
}

function writeProject(content: unknown): void {
  const dir = join(tmpProject, '.pi');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bash-restrictions.json'), JSON.stringify(content));
}

function load(projectTrusted = true) {
  const loaded = loadBashRestrictions(tmpProject, { homeDir: tmpHome, projectTrusted });
  const session: WriteZoneSession = { zone: loaded.zone, cwd: tmpProject, homeDir: tmpHome };
  return { ...loaded, session };
}

type SpyCtx = BashCtx & {
  ui: { select: ReturnType<typeof vi.fn>; input: ReturnType<typeof vi.fn> };
};
function uiCtx(selectResult: string | undefined, inputResult = ''): SpyCtx {
  return {
    hasUI: true,
    ui: {
      select: vi.fn().mockResolvedValue(selectResult),
      input: vi.fn().mockResolvedValue(inputResult),
    },
  };
}
const headlessCtx: BashCtx = { hasUI: false };
const titleOf = (ctx: SpyCtx): string => ctx.ui.select.mock.calls[0][0] as string;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

describe('loader: trustedDirectories', () => {
  it('leaves the write zone off when neither file lists a directory', () => {
    writeGlobal({ trusted: ['ls *'] });
    const { zone, settings } = load();
    expect(zone.enabled).toBe(false);
    expect(settings.trustedDirectories).toEqual([]);
  });

  it('resolves `./` from the global file against the session directory', () => {
    writeGlobal({ trustedDirectories: ['./', tmpOther] });
    const { zone, settings } = load();
    expect(settings.trustedDirectories).toEqual(['./', tmpOther]);
    expect(zone.roots).toEqual([tmpProject, tmpOther]);
    expect(zone.rejected).toEqual([]);
  });

  it('accepts a project entry inside the project and rejects one outside it', () => {
    mkdirSync(join(tmpProject, 'cache'));
    writeProject({ trustedDirectories: ['./cache', tmpOther] });
    const { zone, projectTrustedDirectories } = load();
    expect(projectTrustedDirectories).toEqual(['./cache', tmpOther]);
    expect(zone.roots).toEqual([join(tmpProject, 'cache')]);
    expect(zone.rejected).toEqual([{ entry: tmpOther, reason: 'outside-project' }]);
  });

  it('rejects a project entry that is a link leading out of the project', () => {
    symlinkSync(tmpOther, join(tmpProject, 'link'));
    writeProject({ trustedDirectories: ['./link'] });
    const { zone } = load();
    expect(zone.roots).toEqual([]);
    expect(zone.enabled).toBe(true);
  });

  it('ignores the project file of an untrusted project entirely', () => {
    writeProject({ trusted: ['*'], trustedDirectories: ['./'] });
    const { zone, settings, projectTrustedDirectories } = load(false);
    expect(zone.enabled).toBe(false);
    expect(settings.trusted).toEqual([]);
    expect(projectTrustedDirectories).toEqual([]);
  });

  it('marks both settings files as always-ask', () => {
    writeGlobal({ trustedDirectories: ['./'] });
    writeProject({});
    const { zone } = load();
    expect(zone.protectedFiles).toEqual([
      join(tmpHome, '.pi', 'agent', 'bash-restrictions.json'),
      join(tmpProject, '.pi', 'bash-restrictions.json'),
    ]);
  });

  it('stays on, with nothing inside, when the only entry is not accepted', () => {
    writeProject({ trustedDirectories: [tmpOther] });
    const { zone } = load();
    expect(zone.enabled).toBe(true);
    expect(zone.roots).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

describe('bash tool with the write zone', () => {
  it('runs a trusted command that writes inside the zone without a dialog', async () => {
    writeGlobal({ trusted: ['*'], trustedDirectories: ['./'] });
    const { settings, session } = load();
    const ctx = uiCtx(CHOICE_DENY);
    expect(await resolveBashToolCall('echo x > out.txt', ctx, settings, session)).toBeUndefined();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it('asks about a trusted command that writes outside the zone, and says why', async () => {
    writeGlobal({ trusted: ['*'], trustedDirectories: ['./'] });
    const { settings, session } = load();
    const ctx = uiCtx(CHOICE_DENY);
    const result = await resolveBashToolCall(`echo x > ${tmpOther}/a.txt`, ctx, settings, session);
    expect(result).toEqual({ block: true, reason: "User denied permission for 'bash'." });
    expect(titleOf(ctx)).toContain(
      `Reason: writes outside the trusted directories: ${tmpOther}/a.txt`
    );
  });

  it('runs the multi-line here-document command without a dialog', async () => {
    writeGlobal({ trusted: ['*'], denied: ['brew', 'install'], trustedDirectories: ['./'] });
    const { settings, session } = load();
    const ctx = uiCtx(CHOICE_DENY);
    const command = [
      `cd ${tmpProject} && python3 - <<'PY'`,
      'import pathlib',
      'print(1)',
      'PY',
    ].join('\n');
    expect(await resolveBashToolCall(command, ctx, settings, session)).toBeUndefined();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("asks about a write through $'…' quoting instead of treating it as inside", async () => {
    writeGlobal({ trusted: ['*'], trustedDirectories: ['./'] });
    const { settings, session } = load();
    const ctx = uiCtx(CHOICE_DENY);
    const result = await resolveBashToolCall(
      `echo x > $'${tmpOther}/a.txt'`,
      ctx,
      settings,
      session
    );
    expect(result?.block).toBe(true);
    expect(titleOf(ctx)).toContain('quoting, which cannot be checked');
  });

  it('lets "Allow once" through', async () => {
    writeGlobal({ trusted: ['*'], trustedDirectories: ['./'] });
    const { settings, session } = load();
    const ctx = uiCtx(CHOICE_ALLOW);
    expect(
      await resolveBashToolCall(`echo x > ${tmpOther}/a.txt`, ctx, settings, session)
    ).toBeUndefined();
    expect(ctx.ui.select).toHaveBeenCalledOnce();
  });

  it('blocks an outside write when there is no UI', async () => {
    writeGlobal({ trusted: ['*'], trustedDirectories: ['./'] });
    const { settings, session } = load();
    const result = await resolveBashToolCall(
      `echo x > ${tmpOther}/a.txt`,
      headlessCtx,
      settings,
      session
    );
    expect(result).toEqual({
      block: true,
      reason: 'Blocked by bash restrictions (no UI to confirm)',
    });
  });

  it('never trusts an untrusted command because it stays inside the zone', async () => {
    writeGlobal({ trusted: ['ls *'], trustedDirectories: ['./'] });
    const { settings, session } = load();
    const ctx = uiCtx(CHOICE_DENY);
    const result = await resolveBashToolCall('curl https://x > out.txt', ctx, settings, session);
    expect(result?.block).toBe(true);
    expect(titleOf(ctx)).toContain('Reason: not in the trusted list: curl https://x > out.txt');
  });

  it('still checks writes when both command lists are empty', async () => {
    writeGlobal({ trustedDirectories: ['./'] });
    const { settings, session } = load();
    const quiet = uiCtx(CHOICE_DENY);
    expect(await resolveBashToolCall('ls -la', quiet, settings, session)).toBeUndefined();
    expect(await resolveBashToolCall('echo x > out.txt', quiet, settings, session)).toBeUndefined();
    expect(await resolveBashToolCall('', quiet, settings, session)).toBeUndefined();
    expect(quiet.ui.select).not.toHaveBeenCalled();

    const asked = uiCtx(CHOICE_DENY);
    const result = await resolveBashToolCall(`echo x > ${tmpOther}/a`, asked, settings, session);
    expect(result?.block).toBe(true);
    expect(asked.ui.select).toHaveBeenCalledOnce();
  });

  it('asks before the agent rewrites the project settings file', async () => {
    writeGlobal({ trusted: ['*'] });
    writeProject({ trustedDirectories: ['./'] });
    const { settings, session } = load();
    const ctx = uiCtx(CHOICE_DENY);
    const result = await resolveBashToolCall(
      `echo '{"trusted":["*"]}' > .pi/bash-restrictions.json`,
      ctx,
      settings,
      session
    );
    expect(result?.block).toBe(true);
    expect(titleOf(ctx)).toContain('Reason: writes to a permission settings file');
  });

  it('keeps the command on its own indented line, after the reason', async () => {
    writeGlobal({ trusted: ['*'], trustedDirectories: ['./'] });
    const { settings, session } = load();
    const ctx = uiCtx(CHOICE_DENY);
    await resolveBashToolCall(`echo x > ${tmpOther}/a.txt`, ctx, settings, session);
    const [heading, reason, blank, command] = titleOf(ctx).split('\n');
    expect(heading).toBe('Bash restriction');
    expect(reason.startsWith('Reason: ')).toBe(true);
    expect(blank).toBe('');
    expect(command).toBe(`  echo x > ${tmpOther}/a.txt`);
  });

  it('behaves as before when no zone is passed', async () => {
    writeGlobal({ trusted: ['*'], trustedDirectories: ['./'] });
    const { settings } = load();
    const ctx = uiCtx(CHOICE_DENY);
    expect(await resolveBashToolCall(`echo x > ${tmpOther}/a.txt`, ctx, settings)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// write / edit
// ---------------------------------------------------------------------------

describe('write and edit tools with the write zone', () => {
  it('does nothing when the zone is off', async () => {
    writeGlobal({ trusted: ['*'] });
    const { settings, session } = load();
    const ctx = uiCtx(CHOICE_DENY);
    expect(
      await resolveWriteToolCall('write', { path: `${tmpOther}/a.txt` }, ctx, settings, session)
    ).toBeUndefined();
    expect(await resolveWriteToolCall('write', { path: 'a' }, ctx, settings, undefined)).toBe(
      undefined
    );
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it('lets writes inside the zone through without a dialog', async () => {
    writeGlobal({ trustedDirectories: ['./'] });
    const { settings, session } = load();
    const ctx = uiCtx(CHOICE_DENY);
    expect(
      await resolveWriteToolCall('write', { path: 'src/a.ts' }, ctx, settings, session)
    ).toBeUndefined();
    expect(
      await resolveWriteToolCall('edit', { path: join(tmpProject, 'b.ts') }, ctx, settings, session)
    ).toBeUndefined();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it('asks about a write outside the zone and names the tool in the reasons', async () => {
    writeGlobal({ trustedDirectories: ['./'] });
    const { settings, session } = load();

    const denied = uiCtx(CHOICE_DENY);
    expect(
      await resolveWriteToolCall('write', { path: '~/.zshrc' }, denied, settings, session)
    ).toEqual({ block: true, reason: "User denied permission for 'write'." });
    expect(titleOf(denied)).toBe(
      'Write outside trusted directories\n' +
        `Reason: writes outside the trusted directories: ${join(tmpHome, '.zshrc')}\n\n` +
        '  write ~/.zshrc'
    );

    const suggested = uiCtx(CHOICE_SUGGEST, 'put it in the project');
    const result = await resolveWriteToolCall(
      'edit',
      { path: `${tmpOther}/a.txt` },
      suggested,
      settings,
      session
    );
    expect(result?.reason).toContain("THIS SPECIFIC invocation of 'edit'");
    expect(result?.reason).toContain("User's suggestion: put it in the project");

    const allowed = uiCtx(CHOICE_ALLOW);
    expect(
      await resolveWriteToolCall('write', { path: `${tmpOther}/a` }, allowed, settings, session)
    ).toBeUndefined();
  });

  it('blocks an outside write when there is no UI, or when the dialog times out', async () => {
    writeGlobal({ trustedDirectories: ['./'] });
    const { settings, session } = load();
    expect(
      await resolveWriteToolCall('write', { path: `${tmpOther}/a` }, headlessCtx, settings, session)
    ).toEqual({ block: true, reason: 'Blocked by trusted directories (no UI to confirm)' });
    expect(
      await resolveWriteToolCall(
        'write',
        { path: `${tmpOther}/a` },
        uiCtx(undefined),
        settings,
        session
      )
    ).toEqual({ block: true, reason: 'Blocked (timed out)' });
  });

  it('asks about a write through a link that leads out of the project', async () => {
    symlinkSync(tmpOther, join(tmpProject, 'link'));
    writeGlobal({ trustedDirectories: ['./'] });
    const { settings, session } = load();
    const ctx = uiCtx(CHOICE_DENY);
    const result = await resolveWriteToolCall(
      'write',
      { path: 'link/a.txt' },
      ctx,
      settings,
      session
    );
    expect(result?.block).toBe(true);
    expect(titleOf(ctx)).toContain(`${tmpOther}/a.txt`);
  });

  it('asks before the agent rewrites either settings file', async () => {
    writeGlobal({ trustedDirectories: ['./'] });
    writeProject({});
    const { settings, session } = load();
    for (const target of [
      '.pi/bash-restrictions.json',
      join(tmpHome, '.pi', 'agent', 'bash-restrictions.json'),
    ]) {
      const ctx = uiCtx(CHOICE_DENY);
      const result = await resolveWriteToolCall('edit', { path: target }, ctx, settings, session);
      expect(result?.block, target).toBe(true);
    }
  });

  it('asks when the call carries no path', async () => {
    writeGlobal({ trustedDirectories: ['./'] });
    const { settings, session } = load();
    const ctx = uiCtx(CHOICE_DENY);
    expect((await resolveWriteToolCall('write', {}, ctx, settings, session))?.block).toBe(true);
    expect(titleOf(ctx)).toContain('write (no path)');
  });

  it('honours the configured dialog timeout', async () => {
    writeGlobal({ trustedDirectories: ['./'], permissionTimeoutSeconds: 15 });
    const { settings, session } = load();
    const ctx = uiCtx(CHOICE_DENY);
    await resolveWriteToolCall('write', { path: `${tmpOther}/a` }, ctx, settings, session);
    expect(ctx.ui.select.mock.calls[0][2]).toEqual({ timeout: 15000 });
  });
});
