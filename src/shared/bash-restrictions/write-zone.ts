/**
 * @module shared/bash-restrictions/write-zone
 *
 * The trusted-directories check for bash commands: find the places a command
 * VISIBLY writes to and compare them with the write zone.
 *
 * "Visibly" is the limit of this check. It reads output redirections and `tee`
 * operands from the command text and follows plain `cd` steps. What a program
 * writes on its own (`python3 script.py`, `sed -i`, `bash -c '…'`) cannot be
 * seen from the text; that stays under the `denied` list. This is a permission
 * gate, not a sandbox — see docs/design/trusted-directories.md §6 and §11.
 *
 * Everything that cannot be determined asks. Over-reporting costs a prompt;
 * under-reporting would let a write outside the zone through.
 *
 * Node-standalone; NOT renderer-safe (resolves real paths).
 */
import { homedir } from 'node:os';
import {
  classifyAbsolutePath,
  describeWriteZoneReason,
  normalizeWindowsShellPath,
  resolveShellPath,
  type WriteZoneContext,
  type WriteZoneReason,
} from '../path-permissions';
import {
  explainBashPermission,
  type BashAskReason,
  type BashCommandLists,
  type BashDecision,
} from './engine';
import { scanBashCommand, type ScannedSubCommand, type ScannedWord } from './scan';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Why the write-zone check made a bash command ask. */
export type BashZoneReason = WriteZoneReason | { kind: 'unsupported-syntax'; detail: string };

/** Any reason a bash command asks: from the command lists or from the write zone. */
export type BashReason = BashAskReason | BashZoneReason;

export interface BashZoneDecision {
  decision: BashDecision;
  reason?: BashReason;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Redirection targets that touch no file on disk. */
const HARMLESS_TARGETS: ReadonlySet<string> = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);

/** More possible directories than this and the check stops guessing. */
const MAX_POSSIBLE_DIRECTORIES = 8;

/**
 * The command mentions HOME, PWD, OLDPWD or CDPATH as a bare name (not as
 * `$HOME` / `${HOME}`): it may assign them (`HOME=/etc`, `export HOME`,
 * `read HOME`), after which `~`, `$HOME`, `$PWD` and a relative `cd` no longer
 * mean what they normally do.
 */
const DIRECTORY_VARIABLE_MENTION = /(^|[^A-Za-z0-9_${])(HOME|PWD|OLDPWD|CDPATH)(?![A-Za-z0-9_])/;

interface WordContext {
  home: string;
  /** False when the command may have changed HOME / PWD itself. */
  variablesReliable: boolean;
  /** The single directory the shell is certainly in, when there is exactly one. */
  currentDirectory: string | null;
}

/** The literal value of a word, or null when it cannot be known from the text. */
function wordValue(word: ScannedWord, ctx: WordContext): string | null {
  let out = '';
  for (const segment of word.segments) {
    switch (segment.kind) {
      case 'literal':
        out += segment.text;
        break;
      case 'tilde':
        if (!ctx.variablesReliable) return null;
        out += ctx.home;
        break;
      case 'variable':
        if (!ctx.variablesReliable) return null;
        if (segment.name === 'HOME') out += ctx.home;
        else if (segment.name === 'PWD' && ctx.currentDirectory !== null) {
          out += ctx.currentDirectory;
        } else return null;
        break;
      default:
        return null;
    }
  }
  return out;
}

/** The word exactly as a plain literal, or null when any part of it is not literal. */
function plainLiteral(word: ScannedWord): string | null {
  let out = '';
  for (const segment of word.segments) {
    if (segment.kind !== 'literal') return null;
    out += segment.text;
  }
  return out;
}

function isAbsoluteShellPath(text: string, platform: NodeJS.Platform): boolean {
  if (text.startsWith('/')) return true;
  return platform === 'win32' && (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\'));
}

type DirectoryChange = 'none' | 'unknown' | { operand: string | null };

/**
 * What a sub-command does to the shell's working directory.
 *
 *   - `{ operand }` — the plain form `cd [-L|-P] [dir]`; null operand = home.
 *   - 'unknown'     — it may change directory in a way that cannot be followed.
 *   - 'none'        — it does not change directory.
 */
function readDirectoryChange(sub: ScannedSubCommand, ctx: WordContext): DirectoryChange {
  if (sub.words.length === 0) return 'none';
  const literals = sub.words.map(plainLiteral);
  const first = sub.words[0];

  // A command name built from a variable or expansion could be anything, `cd` included.
  if (first.segments.some((s) => s.kind === 'variable' || s.kind === 'dynamic')) return 'unknown';

  const name = literals[0];
  if (name === 'eval' || name === 'source' || name === '.') return 'unknown';

  const mentionsDirectoryCommand = literals.some(
    (text) => text === 'cd' || text === 'pushd' || text === 'popd'
  );
  if (!mentionsDirectoryCommand) return 'none';
  if (name !== 'cd') return 'unknown';

  // Plain `cd`: skip options, then expect at most one operand.
  let index = 1;
  while (index < sub.words.length) {
    const option = literals[index];
    if (option === '--') {
      index += 1;
      break;
    }
    if (option !== null && /^-[LPe@]+$/.test(option)) {
      index += 1;
      continue;
    }
    break;
  }
  const operands = sub.words.slice(index);
  if (operands.length === 0) return ctx.variablesReliable ? { operand: null } : 'unknown';
  if (operands.length > 1) return 'unknown';
  const operand = wordValue(operands[0], ctx);
  if (operand === null || operand === '' || operand === '-') return 'unknown';
  return { operand };
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Check where a bash command visibly writes.
 *
 * Returns the reason the command must ask, or null when the zone is off or
 * nothing visible lands outside it.
 */
export function checkBashWriteZone(command: string, ctx: WriteZoneContext): BashZoneReason | null {
  if (!ctx.zone.enabled || !command) return null;

  const scan = scanBashCommand(command);
  if (scan.unsupported !== null) {
    return { kind: 'unsupported-syntax', detail: scan.unsupported };
  }

  const platform = ctx.platform ?? process.platform;
  const home = ctx.homeDir ?? homedir();
  const variablesReliable = !DIRECTORY_VARIABLE_MENTION.test(command);
  // A CDPATH in the environment can send a relative `cd` somewhere else.
  const cdPathSet = Boolean(process.env.CDPATH);

  // Directories the shell may be in when the current sub-command runs; null = unknown.
  let possible: string[] | null = ctx.cwd ? [ctx.cwd] : null;
  // Every directory reached since the last point where a `cd` was certain to have run.
  let reached: string[] | null = possible ? [...possible] : null;

  const undetermined = (detail: string): BashZoneReason => ({
    kind: 'write-undetermined',
    detail,
  });

  const checkTarget = (word: ScannedWord | null, shown: string): BashZoneReason | null => {
    if (word === null) return undetermined(`${shown} has no target`);
    const wordCtx: WordContext = {
      home,
      variablesReliable,
      currentDirectory: possible !== null && possible.length === 1 ? possible[0] : null,
    };
    const text = wordValue(word, wordCtx);
    if (text === null || text === '') return undetermined(shown);
    if (HARMLESS_TARGETS.has(text)) return null;

    // On Windows, bash is Git Bash: `/c/x` names a drive, but any other path
    // starting with `/` (`/tmp`, `/etc`, `//server/share`) is mapped by the
    // shell in ways this check cannot reproduce.
    if (platform === 'win32' && text.startsWith('/') && normalizeWindowsShellPath(text) === text) {
      return undetermined(text);
    }

    const absolute = isAbsoluteShellPath(text, platform);
    if (!absolute && possible === null) return undetermined(text);
    const bases = absolute || possible === null ? [''] : possible;
    const candidates = unique(bases.map((base) => resolveShellPath(text, base, { platform })));

    for (const candidate of candidates) {
      const classified = classifyAbsolutePath(candidate, ctx.zone);
      if (classified.zone === 'inside') continue;
      if (classified.zone === 'outside') {
        return { kind: 'write-outside', path: classified.realPath ?? candidate };
      }
      if (classified.zone === 'protected') {
        return { kind: 'write-protected', path: classified.realPath ?? candidate };
      }
      return undetermined(text);
    }
    return null;
  };

  for (const sub of scan.subCommands) {
    // Only `&&` guarantees that an earlier `cd` in the chain succeeded. After
    // any other join the shell may be in any directory reached so far.
    if (sub.joinedBy !== 'start' && sub.joinedBy !== '&&') {
      possible = reached === null ? null : [...reached];
    }

    // 1. Output redirections.
    for (const redirect of sub.redirects) {
      if (redirect.kind !== 'out') continue;
      const reason = checkTarget(redirect.target, `the target of ${redirect.operator}`);
      if (reason) return reason;
    }

    // 2. `tee` operands: every non-option word after the word `tee`.
    const literals = sub.words.map(plainLiteral);
    const teeAt = literals.findIndex((text) => text === 'tee' || Boolean(text?.endsWith('/tee')));
    if (teeAt !== -1) {
      let optionsEnded = false;
      for (let w = teeAt + 1; w < sub.words.length; w += 1) {
        const literal = literals[w];
        if (!optionsEnded && literal === '--') {
          optionsEnded = true;
          continue;
        }
        if (!optionsEnded && literal !== null && literal.startsWith('-')) continue;
        const reason = checkTarget(sub.words[w], 'a tee target');
        if (reason) return reason;
      }
    }

    // 3. The effect of this sub-command on the working directory.
    const wordCtx: WordContext = {
      home,
      variablesReliable,
      currentDirectory: possible !== null && possible.length === 1 ? possible[0] : null,
    };
    const change = readDirectoryChange(sub, wordCtx);
    if (change === 'unknown') {
      possible = null;
      reached = null;
    } else if (change !== 'none' && possible !== null) {
      const operand = change.operand;
      const relativeViaCdPath =
        operand !== null &&
        cdPathSet &&
        !isAbsoluteShellPath(operand, platform) &&
        !/^\.\.?(\/|$)/.test(operand);
      // Same Git Bash limit as for targets: `cd /tmp` on Windows cannot be followed.
      const unmappedOnWindows =
        operand !== null &&
        platform === 'win32' &&
        operand.startsWith('/') &&
        normalizeWindowsShellPath(operand) === operand;
      if (relativeViaCdPath || unmappedOnWindows) {
        possible = null;
        reached = null;
      } else {
        const next = unique(
          possible.map((base) =>
            operand === null ? home : resolveShellPath(operand, base, { platform })
          )
        );
        possible = next;
        reached = reached === null ? null : unique([...reached, ...next]);
        if (reached !== null && reached.length > MAX_POSSIBLE_DIRECTORIES) {
          possible = null;
          reached = null;
        }
      }
    }
  }

  return null;
}

/**
 * The full bash decision: the command lists first, then — only when they did
 * not already ask — the write zone.
 *
 * The zone can only add an `ask`; it never turns the lists' `ask` into
 * `allow`, and it never makes an untrusted command trusted. When both lists
 * are empty the result is `null` (the host's own default applies) unless the
 * zone objects.
 */
export function decideBashWithZone(
  command: string,
  lists: BashCommandLists,
  ctx: WriteZoneContext
): BashZoneDecision {
  const detail = explainBashPermission(command, lists);
  if (detail.decision === 'ask') return detail;
  const zoneReason = checkBashWriteZone(command, ctx);
  if (zoneReason !== null) return { decision: 'ask', reason: zoneReason };
  return detail;
}

/** Human-readable text for any reason a bash command asks, for permission prompts. */
export function describeBashReason(reason: BashReason): string {
  switch (reason.kind) {
    case 'unsupported-syntax':
      return `the command uses ${reason.detail}, which cannot be checked`;
    case 'denied':
      return `matches the denied pattern "${reason.pattern}"`;
    case 'not-trusted': {
      const firstLine = reason.subCommand.split('\n')[0];
      const shown = firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
      return `not in the trusted list: ${shown}`;
    }
    case 'empty':
      return 'there is nothing to run';
    default:
      return describeWriteZoneReason(reason);
  }
}
