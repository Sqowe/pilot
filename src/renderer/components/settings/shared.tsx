// Shared types, constants, and components used across settings tab files.

import type { TFunction } from 'i18next';
import type { ScheduleWeekday } from '../../types';

// ==================== Shared Types ====================

export interface UserCredential {
  id: string;
  name: string;
  type: 'email' | 'website' | 'api' | 'other';
  service?: string;
  username: string;
  password?: string;
  url?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MCPServerConfig {
  id: string;
  name: string;
  type: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
}

export interface MCPServerStatus {
  id: string;
  name: string;
  connected: boolean;
  toolCount: number;
}

export type CredentialDraft = Omit<UserCredential, 'id' | 'createdAt' | 'updatedAt'>;

export interface MCPToolInfo {
  serverId: string;
  name: string;
  description?: string;
}

export interface MCPPreset {
  name: string;
  type: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  requiresEnv?: string[];
  envDescription?: Record<string, string>;
}

export type LocalizedBanner = { key?: string; text?: string };

export type ScheduleFormMode = 'once' | 'daily' | 'weekly' | 'legacy-interval';

// ==================== Shared Constants ====================

export const SERVICE_OPTIONS = [
  { value: 'gmail', label: 'Gmail' },
  { value: 'outlook', label: 'Outlook / Hotmail' },
  { value: 'yahoo', label: 'Yahoo Mail' },
  { value: 'netease', label: 'NetEase Mail (163/126)' },
  { value: 'qq', label: 'QQ Mail' },
  { value: 'icloud', label: 'iCloud Mail' },
  { value: 'proton', label: 'ProtonMail' },
  { value: 'github', label: 'GitHub' },
  { value: 'gitlab', label: 'GitLab' },
  { value: 'aws', label: 'AWS' },
  { value: 'azure', label: 'Azure' },
  { value: 'other', label: 'Other' },
];

// ==================== Shared Helpers ====================

export function renderLocalizedBannerMessage(banner: LocalizedBanner, t: TFunction): string {
  return banner.key ? t(banner.key) : banner.text || '';
}

export function getWeekdayOptions(t: TFunction): Array<{ value: ScheduleWeekday; label: string }> {
  return [
    { value: 1, label: t('schedule.weekdayMonday') },
    { value: 2, label: t('schedule.weekdayTuesday') },
    { value: 3, label: t('schedule.weekdayWednesday') },
    { value: 4, label: t('schedule.weekdayThursday') },
    { value: 5, label: t('schedule.weekdayFriday') },
    { value: 6, label: t('schedule.weekdaySaturday') },
    { value: 0, label: t('schedule.weekdaySunday') },
  ];
}

export function getScheduleModeOptions(
  t: TFunction
): Array<{ value: ScheduleFormMode; label: string }> {
  return [
    { value: 'once', label: t('schedule.modeOnce') },
    { value: 'daily', label: t('schedule.modeDaily') },
    { value: 'weekly', label: t('schedule.modeWeekly') },
  ];
}

// ==================== Shared UI Component ====================

export function SettingsContentSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 py-5 border-b border-border-muted">
      <div className="space-y-1">
        <h4 className="text-sm font-semibold text-text-primary">{title}</h4>
        {description && <p className="text-xs leading-5 text-text-muted">{description}</p>}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}
