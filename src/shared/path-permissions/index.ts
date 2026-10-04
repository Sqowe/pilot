/**
 * @module shared/path-permissions
 *
 * Public API for the trusted-directories write zone
 * (docs/design/trusted-directories.md). Import from here rather than from the
 * individual sub-modules.
 *
 * Consumed by the Electron main process and the pi CLI extension. Everything
 * except `containment` touches the file system: this module is Node-standalone
 * and NOT renderer-safe.
 */
export { isPathWithinRoot, normalizePathForContainment } from './containment';

export type { ResolveOptions } from './resolve';
export {
  isCaseInsensitivePlatform,
  normalizeWindowsShellPath,
  realpathExistingPortion,
  resolveShellPath,
  resolveToolPath,
} from './resolve';

export type {
  BuildWriteZoneInput,
  PathZone,
  RejectedDirectory,
  RejectedDirectoryReason,
  WriteZone,
} from './zone';
export {
  DISABLED_WRITE_ZONE,
  buildWriteZone,
  classifyAbsolutePath,
  classifyRealPath,
  describeRejectedDirectory,
} from './zone';

export type { WriteToolDecision, WriteZoneContext, WriteZoneReason } from './tool-decision';
export { WRITE_ZONE_TOOLS, decideWriteToolZone, describeWriteZoneReason } from './tool-decision';
