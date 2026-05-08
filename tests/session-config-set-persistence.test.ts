import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const databasePath = path.resolve(process.cwd(), 'src/main/db/database.ts');
const sessionManagerPath = path.resolve(process.cwd(), 'src/main/session/session-manager.ts');
const typesPath = path.resolve(process.cwd(), 'src/renderer/types/index.ts');

describe('Session configSetId persistence', () => {
  const dbSource = fs.readFileSync(databasePath, 'utf8');
  const smSource = fs.readFileSync(sessionManagerPath, 'utf8');
  const typesSource = fs.readFileSync(typesPath, 'utf8');

  describe('schema migration', () => {
    it('adds config_set_id column via ensureColumn migration', () => {
      expect(dbSource).toContain(
        "ensureColumn(database, 'sessions', 'config_set_id', 'config_set_id TEXT')"
      );
    });

    it('includes config_set_id in SessionRow interface', () => {
      expect(dbSource).toContain('config_set_id: string | null;');
    });

    it('includes config_set_id in the INSERT statement', () => {
      expect(dbSource).toContain(
        'id, title, claude_session_id, openai_thread_id, status, cwd, mounted_paths, allowed_tools, memory_enabled, model, config_set_id, created_at, updated_at'
      );
    });

    it('passes config_set_id in sessions.create()', () => {
      expect(dbSource).toContain('session.config_set_id,');
    });
  });

  describe('Session type', () => {
    it('includes configSetId as optional field on Session interface', () => {
      expect(typesSource).toContain('configSetId?: string;');
    });
  });

  describe('session creation', () => {
    it('stores activeConfigSetId from configStore on new session', () => {
      expect(smSource).toContain("configSetId: configStore.get('activeConfigSetId') || undefined,");
    });

    it('writes configSetId to database via saveSession', () => {
      expect(smSource).toContain('config_set_id: session.configSetId || null,');
    });
  });

  describe('session loading', () => {
    it('reads config_set_id from DB row in loadSession', () => {
      expect(smSource).toContain('configSetId: row.config_set_id || undefined,');
    });

    it('reads config_set_id from DB row in listSessions', () => {
      // Should appear at least twice (loadSession + listSessions)
      const matches = smSource.match(/configSetId: row\.config_set_id \|\| undefined/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('session update on continue', () => {
    it('updates configSetId when active config set changes during continueSession', () => {
      expect(smSource).toContain(
        "const currentConfigSetId = configStore.get('activeConfigSetId') ?? null;"
      );
      expect(smSource).toContain('const sessionConfigSetId = session.configSetId ?? null;');
      expect(smSource).toContain('if (currentConfigSetId !== sessionConfigSetId)');
      expect(smSource).toContain('session.configSetId = currentConfigSetId || undefined;');
      expect(smSource).toContain(
        'this.db.sessions.update(session.id, { config_set_id: currentConfigSetId });'
      );
    });

    it('handles null/cleared config set IDs via nullish normalization', () => {
      // Both sides are normalized with ?? null so clearing is detected
      expect(smSource).toContain("configStore.get('activeConfigSetId') ?? null");
      expect(smSource).toContain('session.configSetId ?? null');
    });

    it('notifies renderer of configSetId update via session.update event', () => {
      expect(smSource).toContain('updates: { configSetId: currentConfigSetId || undefined }');
    });
  });
});
