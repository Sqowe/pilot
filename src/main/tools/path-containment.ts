// Moved to `src/shared/path-permissions/containment.ts` so the pi CLI extension
// can use the same comparison. Re-exported here so existing importers are unchanged.
export {
  isPathWithinRoot,
  normalizePathForContainment,
} from '../../shared/path-permissions/containment';
