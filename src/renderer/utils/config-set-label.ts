import type { ApiConfigSet } from '../types';

/**
 * How a config set is named where one is picked for a chat: its name, then the
 * model it selects.
 *
 * The model is what tells two sets apart at the moment of choosing. The
 * provider is left out on purpose: since credentials moved out of config sets
 * it is no longer part of what a set is (design §6.6).
 */
export function configSetLabel(set: Pick<ApiConfigSet, 'name' | 'model'>): string {
  const model = (set.model ?? '').trim();
  return model ? `${set.name} · ${model}` : set.name;
}
