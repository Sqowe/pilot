/**
 * How a config set is named where one is picked for a chat (design §6.6): its
 * name and the model it selects, in the chat header and on the welcome screen.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { configSetLabel } from '../src/renderer/utils/config-set-label';

describe('the label of a config set in a picker', () => {
  it('is the name, then the model', () => {
    expect(configSetLabel({ name: 'Work', model: 'claude-opus-5' })).toBe('Work · claude-opus-5');
    expect(configSetLabel({ name: 'Local', model: 'anthropic/claude-sonnet-4.6' })).toBe(
      'Local · anthropic/claude-sonnet-4.6'
    );
  });

  it('is the name alone for a set that names no model', () => {
    expect(configSetLabel({ name: 'Work', model: '' })).toBe('Work');
    expect(configSetLabel({ name: 'Work', model: '   ' })).toBe('Work');
    // A set as an older build may have left it.
    expect(configSetLabel({ name: 'Work' } as { name: string; model: string })).toBe('Work');
  });

  it('does not name the provider, which is no longer part of what a set is', () => {
    const label = configSetLabel({
      name: 'Work',
      model: 'claude-opus-5',
      provider: 'anthropic',
    } as { name: string; model: string });

    expect(label).not.toMatch(/anthropic/i);
  });
});

describe('the two pickers', () => {
  const read = (file: string) =>
    fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/components', file), 'utf8');

  it.each(['ChatView.tsx', 'WelcomeView.tsx'])('label each set that way in %s', (file) => {
    const source = read(file);

    expect(source).toContain("import { configSetLabel } from '../utils/config-set-label';");
    expect(source).toContain('{configSetLabel(set)}');
    // The option still stands for the set, whatever it is labelled.
    expect(source).toContain('<option key={set.id} value={set.id}>');
    expect(source).not.toMatch(/<option key=\{set\.id\} value=\{set\.id\}>\s*\{set\.name\}/);
  });
});
