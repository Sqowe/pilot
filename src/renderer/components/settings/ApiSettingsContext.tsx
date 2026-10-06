import { createContext, useContext, type ReactNode } from 'react';
import { useApiSettingsState, type ApiSettingsState } from '../../hooks/useApiSettingsState';

/** Exported so a test can render a tab against a state it has built itself. */
export const ApiSettingsContext = createContext<ApiSettingsState | null>(null);

interface ApiSettingsProviderProps {
  children: ReactNode;
}

/**
 * Creates the state the Providers and Model Sets tabs share, once, above both.
 *
 * Settings tabs stay mounted after their first visit. Two tabs that each built
 * their own copy of this state would drift apart at the first save: an endpoint
 * added on one would be missing from the chooser on the other.
 */
export function ApiSettingsProvider({ children }: ApiSettingsProviderProps) {
  const state = useApiSettingsState();
  return <ApiSettingsContext.Provider value={state}>{children}</ApiSettingsContext.Provider>;
}

export function useApiSettings(): ApiSettingsState {
  const state = useContext(ApiSettingsContext);
  if (!state) {
    throw new Error('useApiSettings must be used inside ApiSettingsProvider');
  }
  return state;
}
