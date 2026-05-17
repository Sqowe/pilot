/**
 * Tests for MCP custom tool filtering logic.
 * Imports the production function directly to prevent test/implementation drift.
 * Validates exact server-name matching via metadata, not name parsing.
 */
import { describe, it, expect } from 'vitest';
import { filterMcpCustomTools } from '../src/main/claude/agent-runner';

// Helper to create mock McpToolDefinition-like objects
function mockTool(name: string, serverName: string) {
  return { name, _mcpServerName: serverName } as Parameters<typeof filterMcpCustomTools>[0][number];
}

describe('filterMcpCustomTools', () => {
  describe('basic filtering', () => {
    it('includes tools from effective servers', () => {
      const tools = [
        mockTool('mcp__EODHD__get_stock', 'EODHD'),
        mockTool('mcp__EODHD__get_price', 'EODHD'),
        mockTool('mcp__PubMed__search', 'PubMed'),
      ];
      const effective = new Set(['EODHD', 'PubMed']);
      const result = filterMcpCustomTools(tools, effective);
      expect(result).toHaveLength(3);
    });

    it('excludes tools from disabled servers', () => {
      const tools = [
        mockTool('mcp__EODHD__get_stock', 'EODHD'),
        mockTool('mcp__EODHD__get_price', 'EODHD'),
        mockTool('mcp__PubMed__search', 'PubMed'),
        mockTool('mcp__Eurostat__query', 'Eurostat'),
      ];
      const effective = new Set(['EODHD']); // Only EODHD enabled
      const result = filterMcpCustomTools(tools, effective);
      expect(result).toHaveLength(2);
      expect(result.every((t) => t._mcpServerName === 'EODHD')).toBe(true);
    });

    it('returns empty array when no servers are effective', () => {
      const tools = [
        mockTool('mcp__EODHD__get_stock', 'EODHD'),
        mockTool('mcp__PubMed__search', 'PubMed'),
      ];
      const effective = new Set<string>();
      const result = filterMcpCustomTools(tools, effective);
      expect(result).toHaveLength(0);
    });

    it('returns all tools when all servers are effective', () => {
      const tools = [
        mockTool('mcp__A__tool1', 'A'),
        mockTool('mcp__B__tool2', 'B'),
        mockTool('mcp__C__tool3', 'C'),
      ];
      const effective = new Set(['A', 'B', 'C']);
      const result = filterMcpCustomTools(tools, effective);
      expect(result).toHaveLength(3);
    });
  });

  describe('server names containing __ (exact metadata matching)', () => {
    it('includes tool from server with __ in name when that server is effective', () => {
      const tools = [
        mockTool('mcp__My__Server__get_data', 'My__Server'),
        mockTool('mcp__Other__tool', 'Other'),
      ];
      const effective = new Set(['My__Server']);
      const result = filterMcpCustomTools(tools, effective);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('mcp__My__Server__get_data');
    });

    it('does NOT confuse similar prefixes — exact metadata match required', () => {
      // "My" is enabled but "My__Server" is disabled
      // Tool belongs to "My__Server" (per metadata), NOT "My"
      const tools = [mockTool('mcp__My__Server__get_data', 'My__Server')];
      const effective = new Set(['My']); // Only "My" is effective
      const result = filterMcpCustomTools(tools, effective);
      // Must be excluded — tool belongs to "My__Server", not "My"
      expect(result).toHaveLength(0);
    });

    it('correctly distinguishes overlapping server names', () => {
      const tools = [
        mockTool('mcp__My__tool1', 'My'),
        mockTool('mcp__My__Server__tool2', 'My__Server'),
      ];
      // Only "My" is enabled, "My__Server" is disabled
      const effective = new Set(['My']);
      const result = filterMcpCustomTools(tools, effective);
      expect(result).toHaveLength(1);
      expect(result[0]._mcpServerName).toBe('My');
    });
  });

  describe('edge cases', () => {
    it('handles empty tools array', () => {
      const result = filterMcpCustomTools([], new Set(['EODHD']));
      expect(result).toHaveLength(0);
    });

    it('handles empty effective set with tools', () => {
      const tools = [mockTool('mcp__X__y', 'X')];
      const result = filterMcpCustomTools(tools, new Set());
      expect(result).toHaveLength(0);
    });
  });

  describe('no-regression: all servers enabled', () => {
    it('keeps all tools when effective set matches all servers', () => {
      const tools = [
        mockTool('mcp__EODHD__get_stock', 'EODHD'),
        mockTool('mcp__EODHD__get_price', 'EODHD'),
        mockTool('mcp__PubMed__search', 'PubMed'),
        mockTool('mcp__PubMed__fetch', 'PubMed'),
        mockTool('mcp__Eurostat__query', 'Eurostat'),
        mockTool('mcp__Hungarian_Law__search_law', 'Hungarian_Law'),
        mockTool('mcp__Legal_Data_Worldwide__search', 'Legal_Data_Worldwide'),
      ];
      const effective = new Set([
        'EODHD',
        'PubMed',
        'Eurostat',
        'Hungarian_Law',
        'Legal_Data_Worldwide',
      ]);
      const result = filterMcpCustomTools(tools, effective);
      expect(result).toHaveLength(7);
    });
  });
});
