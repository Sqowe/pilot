/**
 * @module shared/permission-reason
 *
 * Why a tool call was sent to the user instead of running on its own. Carried
 * from the main-process permission gate to the permission dialog so the prompt
 * can say what triggered it.
 *
 * Renderer-safe: type-only imports, erased at compile time. Do not turn these
 * into value imports — `path-permissions` touches the file system.
 */
import type { BashAskReason } from './bash-restrictions/engine';
import type { WriteZoneReason } from './path-permissions/tool-decision';

/**
 * - `unsupported-syntax`  — a bash command the gate cannot read safely
 * - `denied`              — a sub-command contains a denied pattern
 * - `not-trusted`         — a sub-command matches no trusted pattern
 * - `empty`               — nothing is left to run after splitting
 * - `write-outside`       — a write lands outside the trusted directories
 * - `write-protected`     — a write targets a permission settings file
 * - `write-undetermined`  — where a write lands cannot be determined
 */
export type PermissionAskReason = BashAskReason | WriteZoneReason;
