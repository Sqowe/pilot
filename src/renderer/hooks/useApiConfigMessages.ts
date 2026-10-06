import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type MessageValues = Record<string, string | number>;

/** A message is either a raw string or an i18n key with optional values. */
interface Message {
  text: string;
  key: string | null;
  values: MessageValues | undefined;
}

const NO_MESSAGE: Message = { text: '', key: null, values: undefined };

export interface ApiConfigMessages {
  error: string;
  successMessage: string;
  showErrorKey: (key: string, values?: MessageValues) => void;
  showErrorText: (text: string) => void;
  clearError: () => void;
  showSuccessKey: (key: string, values?: MessageValues) => void;
  showSuccessText: (text: string) => void;
  clearSuccessMessage: () => void;
}

/**
 * The one error line and one success line of an API-settings screen.
 *
 * Shared by the state slices on that screen so a failed credential save and a
 * failed set save report in the same place. Keys are translated on render, so
 * a message follows a language change.
 */
export function useApiConfigMessages(): ApiConfigMessages {
  const { t } = useTranslation();
  const [errorMessage, setErrorMessage] = useState<Message>(NO_MESSAGE);
  const [success, setSuccess] = useState<Message>(NO_MESSAGE);

  const clearError = useCallback(() => setErrorMessage(NO_MESSAGE), []);
  const showErrorKey = useCallback(
    (key: string, values?: MessageValues) => setErrorMessage({ text: '', key, values }),
    []
  );
  const showErrorText = useCallback(
    (text: string) => setErrorMessage({ text, key: null, values: undefined }),
    []
  );
  const clearSuccessMessage = useCallback(() => setSuccess(NO_MESSAGE), []);
  const showSuccessKey = useCallback(
    (key: string, values?: MessageValues) => setSuccess({ text: '', key, values }),
    []
  );
  const showSuccessText = useCallback(
    (text: string) => setSuccess({ text, key: null, values: undefined }),
    []
  );

  const error = errorMessage.key ? t(errorMessage.key, errorMessage.values) : errorMessage.text;
  const successMessage = success.key ? t(success.key, success.values) : success.text;

  return useMemo(
    () => ({
      error,
      successMessage,
      showErrorKey,
      showErrorText,
      clearError,
      showSuccessKey,
      showSuccessText,
      clearSuccessMessage,
    }),
    [
      error,
      successMessage,
      showErrorKey,
      showErrorText,
      clearError,
      showSuccessKey,
      showSuccessText,
      clearSuccessMessage,
    ]
  );
}
