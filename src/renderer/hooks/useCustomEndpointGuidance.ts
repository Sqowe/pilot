import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { CustomProtocolType, ProviderPresets, ProviderType } from '../types';
import {
  detectCommonProviderSetup,
  getFallbackOpenAISetup,
  isParsableBaseUrl,
  orderCommonProviderSetups,
  resolveProviderGuidanceErrorHint,
  type CommonProviderSetup,
} from '../../shared/api-provider-guidance';
import { protocolLabel, providerTabLabel } from './api-config-shared';

interface UseCustomEndpointGuidanceOptions {
  provider: ProviderType;
  customProtocol: CustomProtocolType;
  baseUrl: string;
  presets: ProviderPresets;
  /** Raw details of the last connection test, for a friendlier hint. */
  testDetails: string | undefined;
}

/**
 * The hints shown while a custom endpoint is being typed in: which well-known
 * service the address looks like, whether the chosen protocol suits it, and the
 * list of common setups to fill the form from. Empty for any other provider.
 */
export function useCustomEndpointGuidance(options: UseCustomEndpointGuidanceOptions) {
  const { t } = useTranslation();
  const { provider, customProtocol, baseUrl, presets, testDetails } = options;

  const detectedProviderSetup = useMemo(
    () => (provider === 'custom' ? detectCommonProviderSetup(baseUrl) : null),
    [baseUrl, provider]
  );
  const fallbackOpenAISetup = useMemo(() => getFallbackOpenAISetup(), []);
  const effectiveProviderSetup = useMemo(() => {
    if (detectedProviderSetup) {
      return detectedProviderSetup;
    }
    if (
      provider === 'custom' &&
      customProtocol === 'openai' &&
      baseUrl.trim() &&
      isParsableBaseUrl(baseUrl)
    ) {
      return fallbackOpenAISetup;
    }
    return null;
  }, [baseUrl, customProtocol, detectedProviderSetup, fallbackOpenAISetup, provider]);
  const setupDisplayProtocol = useCallback(
    (setup: CommonProviderSetup) =>
      setup.protocolLabel || protocolLabel(setup.recommendedProtocol, t),
    [t]
  );
  const protocolGuidanceTone = useMemo<'info' | 'warning' | undefined>(() => {
    if (provider !== 'custom' || !detectedProviderSetup) {
      return undefined;
    }
    if (detectedProviderSetup.preferProviderTab) {
      return 'warning';
    }
    return customProtocol === detectedProviderSetup.recommendedProtocol ? 'info' : 'warning';
  }, [customProtocol, detectedProviderSetup, provider]);
  const protocolGuidanceText = useMemo(() => {
    if (provider !== 'custom' || !detectedProviderSetup) {
      return '';
    }

    const serviceName = t(detectedProviderSetup.nameKey);
    if (detectedProviderSetup.preferProviderTab) {
      return t('api.guidance.preferProviderTab', {
        service: serviceName,
        provider: providerTabLabel(detectedProviderSetup.preferProviderTab, presets, t),
      });
    }

    if (customProtocol !== detectedProviderSetup.recommendedProtocol) {
      return t('api.guidance.protocolMismatch', {
        service: serviceName,
        recommendedProtocol: setupDisplayProtocol(detectedProviderSetup),
      });
    }

    return t('api.guidance.protocolLooksGood', {
      service: serviceName,
      recommendedProtocol: setupDisplayProtocol(detectedProviderSetup),
    });
  }, [customProtocol, detectedProviderSetup, presets, provider, setupDisplayProtocol, t]);
  const baseUrlGuidanceText = useMemo(() => {
    if (provider !== 'custom' || !effectiveProviderSetup) {
      return '';
    }

    if (!detectedProviderSetup && effectiveProviderSetup.id === fallbackOpenAISetup.id) {
      return t('api.guidance.genericBaseUrlHint', {
        recommendedProtocol: setupDisplayProtocol(effectiveProviderSetup),
        baseUrl: effectiveProviderSetup.recommendedBaseUrl,
        model: effectiveProviderSetup.exampleModel,
      });
    }

    return t('api.guidance.baseUrlHint', {
      service: t(effectiveProviderSetup.nameKey),
      recommendedProtocol: setupDisplayProtocol(effectiveProviderSetup),
      baseUrl: effectiveProviderSetup.recommendedBaseUrl,
      model: effectiveProviderSetup.exampleModel,
    });
  }, [
    detectedProviderSetup,
    effectiveProviderSetup,
    fallbackOpenAISetup.id,
    provider,
    setupDisplayProtocol,
    t,
  ]);
  const commonProviderSetups = useMemo(
    () =>
      provider === 'custom'
        ? orderCommonProviderSetups(detectedProviderSetup?.id).map((setup) => ({
            id: setup.id,
            name: t(setup.nameKey),
            protocolLabel: setupDisplayProtocol(setup),
            baseUrl: setup.recommendedBaseUrl,
            exampleModel: setup.exampleModel,
            notes: t(setup.noteKey),
            isDetected: setup.id === detectedProviderSetup?.id,
          }))
        : [],
    [detectedProviderSetup?.id, provider, setupDisplayProtocol, t]
  );
  const friendlyTestDetails = useMemo(() => {
    const hintKind = resolveProviderGuidanceErrorHint(testDetails, detectedProviderSetup);
    if (!hintKind) {
      return '';
    }

    if (hintKind === 'emptyProbePreferProvider' && detectedProviderSetup?.preferProviderTab) {
      return t('api.guidance.errorHints.emptyProbePreferProvider', {
        service: t(detectedProviderSetup.nameKey),
        provider: providerTabLabel(detectedProviderSetup.preferProviderTab, presets, t),
      });
    }
    if (hintKind === 'emptyProbeDetected' && effectiveProviderSetup) {
      return t('api.guidance.errorHints.emptyProbeDetected', {
        service: t(effectiveProviderSetup.nameKey),
        recommendedProtocol: setupDisplayProtocol(effectiveProviderSetup),
      });
    }
    if (hintKind === 'emptyProbeGeneric') {
      return t('api.guidance.errorHints.emptyProbeGeneric');
    }
    if (hintKind === 'probeMismatchDetected' && effectiveProviderSetup) {
      return t('api.guidance.errorHints.probeMismatchDetected', {
        service: t(effectiveProviderSetup.nameKey),
        recommendedProtocol: setupDisplayProtocol(effectiveProviderSetup),
      });
    }
    if (hintKind === 'probeMismatchGeneric') {
      return t('api.guidance.errorHints.probeMismatchGeneric');
    }

    return '';
  }, [
    detectedProviderSetup,
    effectiveProviderSetup,
    presets,
    setupDisplayProtocol,
    t,
    testDetails,
  ]);

  return {
    detectedProviderSetup,
    protocolGuidanceTone,
    protocolGuidanceText,
    baseUrlGuidanceText,
    commonProviderSetups,
    friendlyTestDetails,
  };
}
