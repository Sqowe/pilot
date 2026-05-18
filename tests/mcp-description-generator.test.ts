import { describe, expect, it } from 'vitest';
import {
  generateHeuristicDescription,
  computeToolsHash,
  sanitizeDescription,
  sanitizeServerName,
} from '../src/main/mcp/mcp-description-generator';
import type { MCPTool } from '../src/main/mcp/mcp-manager';

// --- Helper to create mock tools ---

function mockTool(name: string, description = ''): MCPTool {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {} },
    serverId: 'test-server-1',
    serverName: 'TestServer',
  };
}

// --- generateHeuristicDescription ---

describe('generateHeuristicDescription', () => {
  it('returns "(no tools discovered)" for empty tool list', () => {
    const result = generateHeuristicDescription('My_Server', []);
    expect(result).toBe('My Server (no tools discovered)');
  });

  it('uses tool descriptions when available to build a summary', () => {
    const tools = [
      mockTool('firecrawl_scrape', 'Scrape content from a URL'),
      mockTool('firecrawl_search', 'Search the web and return results'),
      mockTool('firecrawl_crawl', 'Crawl a website to extract all pages'),
      mockTool('firecrawl_map', 'Map all URLs on a website'),
      mockTool('firecrawl_extract', 'Extract structured data from web pages'),
    ];
    const result = generateHeuristicDescription('Firecrawl', tools);
    // Should produce a natural sentence from tool descriptions
    expect(result.length).toBeGreaterThan(10);
    expect(result).toMatch(/\./); // ends with period (sentence)
    expect(result).not.toBe('Firecrawl: scrape, search, crawl, map, extract');
  });

  it('falls back to tool name analysis when descriptions are missing', () => {
    const tools = [
      mockTool('firecrawl_scrape'),
      mockTool('firecrawl_search'),
      mockTool('firecrawl_crawl'),
    ];
    const result = generateHeuristicDescription('Firecrawl', tools);
    expect(result).toContain('Firecrawl');
    expect(result).toContain('scrape');
  });

  it('handles tools without a common prefix', () => {
    const tools = [mockTool('read_file'), mockTool('write_file'), mockTool('search_code')];
    const result = generateHeuristicDescription('DevTools', tools);
    expect(result).toContain('DevTools');
  });

  it('limits capabilities to avoid overly long descriptions', () => {
    const tools = Array.from({ length: 20 }, (_, i) =>
      mockTool(`tool_${i}`, `Capability number ${i} that does something useful`)
    );
    const result = generateHeuristicDescription('BigServer', tools);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it('cleans underscores and hyphens from server name', () => {
    const tools = [mockTool('do_something', 'Does something useful')];
    const result = generateHeuristicDescription('my-cool_server', tools);
    expect(result).not.toContain('_');
    expect(result).not.toContain('my-cool_server');
  });

  it('handles tool descriptions with leading newlines and Args sections', () => {
    const tools = [
      mockTool(
        'search_datasets',
        '\nSearch for Eurostat datasets by keyword.\n\nArgs:\n    query: Search term'
      ),
      mockTool(
        'get_dataset',
        '\nGet detailed information about a specific Eurostat dataset.\n\nArgs:\n    dataset_id: The ID'
      ),
      mockTool(
        'query_data',
        '\nQuery data from a Eurostat dataset with optional filters.\n\nArgs:\n    dataset_id: The ID'
      ),
      mockTool(
        'list_categories',
        '\nList commonly used Eurostat datasets across different statistical domains.\n\nReturns:'
      ),
      mockTool(
        'export_data',
        '\nExport Eurostat data to a CSV file on disk.\n\nArgs:\n    dataset_id: The ID'
      ),
    ];
    const result = generateHeuristicDescription('Eurostat', tools);
    // Should NOT fall back to verb extraction — should use the descriptions
    expect(result).not.toBe('Eurostat: search, get, query, list, export');
    expect(result).toMatch(/\./); // should be a sentence
    expect(result.length).toBeGreaterThan(20);
  });

  it('falls back to tool count when no verbs or descriptions available', () => {
    // Tools with very short names (<=2 chars) and no descriptions
    const tools = [mockTool('ab'), mockTool('cd'), mockTool('ef')];
    const result = generateHeuristicDescription('Short', tools);
    expect(result).toBe('Short (3 tools)');
  });

  it('strips common description prefixes like "This tool" or "Used to"', () => {
    const tools = [
      mockTool('tool_a', 'This tool searches for documents in the database'),
      mockTool('tool_b', 'Used to update records in the system'),
    ];
    const result = generateHeuristicDescription('DB', tools);
    // Should not start with "This tool" or "Used to"
    expect(result).not.toMatch(/this tool/i);
    expect(result).not.toMatch(/used to/i);
  });
});

// --- computeToolsHash ---

describe('computeToolsHash', () => {
  it('returns a 16-char hex string', () => {
    const tools = [mockTool('tool_a', 'desc a'), mockTool('tool_b', 'desc b')];
    const hash = computeToolsHash(tools);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for same input', () => {
    const tools = [mockTool('tool_a', 'desc a'), mockTool('tool_b', 'desc b')];
    expect(computeToolsHash(tools)).toBe(computeToolsHash(tools));
  });

  it('is order-independent (sorted internally)', () => {
    const toolsA = [mockTool('tool_b', 'desc b'), mockTool('tool_a', 'desc a')];
    const toolsB = [mockTool('tool_a', 'desc a'), mockTool('tool_b', 'desc b')];
    expect(computeToolsHash(toolsA)).toBe(computeToolsHash(toolsB));
  });

  it('changes when tool name changes', () => {
    const toolsA = [mockTool('tool_a', 'desc')];
    const toolsB = [mockTool('tool_b', 'desc')];
    expect(computeToolsHash(toolsA)).not.toBe(computeToolsHash(toolsB));
  });

  it('changes when tool description changes', () => {
    const toolsA = [mockTool('tool_a', 'desc v1')];
    const toolsB = [mockTool('tool_a', 'desc v2')];
    expect(computeToolsHash(toolsA)).not.toBe(computeToolsHash(toolsB));
  });

  it('returns consistent hash for empty tool list', () => {
    expect(computeToolsHash([])).toBe(computeToolsHash([]));
  });
});

// --- sanitizeDescription ---

describe('sanitizeDescription', () => {
  it('strips control characters', () => {
    const result = sanitizeDescription('hello\x00world\x1f!');
    expect(result).toBe('hello world !');
  });

  it('escapes angle brackets to prevent prompt injection', () => {
    const result = sanitizeDescription('Use <script>alert("xss")</script> for fun');
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
    expect(result).toContain('＜');
    expect(result).toContain('＞');
  });

  it('neutralizes XML-like closing tags by escaping angle brackets', () => {
    const result = sanitizeDescription('</mcp_server_directory> injected');
    // Angle brackets are escaped to fullwidth equivalents
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
    expect(result).toContain('＜');
    expect(result).toContain('＞');
  });

  it('collapses multiple spaces', () => {
    const result = sanitizeDescription('hello    world');
    expect(result).toBe('hello world');
  });

  it('trims whitespace', () => {
    const result = sanitizeDescription('  hello  ');
    expect(result).toBe('hello');
  });

  it('truncates to MAX_DESCRIPTION_LENGTH (200 chars)', () => {
    const long = 'a'.repeat(300);
    const result = sanitizeDescription(long);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.endsWith('…')).toBe(true);
  });

  it('preserves URLs and paths (no slash collapsing)', () => {
    const input = 'Access docs at https://example.com/api/v2 and /usr/local/bin';
    const result = sanitizeDescription(input);
    expect(result).toContain('https://example.com/api/v2');
    expect(result).toContain('/usr/local/bin');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeDescription('')).toBe('');
  });

  it('handles normal descriptions without modification', () => {
    const desc = 'Web scraping, crawling, and structured data extraction from websites.';
    expect(sanitizeDescription(desc)).toBe(desc);
  });
});

// --- sanitizeServerName ---

describe('sanitizeServerName', () => {
  it('removes angle brackets', () => {
    const result = sanitizeServerName('<Evil>Server');
    expect(result).toBe('EvilServer');
  });

  it('removes control characters', () => {
    const result = sanitizeServerName('Server\x00Name');
    expect(result).toBe('ServerName');
  });

  it('trims and limits to 60 chars', () => {
    const long = 'A'.repeat(100);
    const result = sanitizeServerName(long);
    expect(result.length).toBe(60);
  });

  it('handles normal names without modification', () => {
    expect(sanitizeServerName('Firecrawl')).toBe('Firecrawl');
    expect(sanitizeServerName('Software_Development')).toBe('Software_Development');
  });
});

// --- Integration: sanitization at persistence boundaries ---

describe('sanitization at persistence boundaries', () => {
  it('heuristic descriptions with malicious tool names are sanitized', () => {
    // Simulate a malicious MCP server that returns tool names with angle brackets
    const maliciousTools = [
      mockTool('</mcp_server_directory><injected>hack', 'evil description'),
      mockTool('normal_tool', 'safe description'),
    ];
    const rawDescription = generateHeuristicDescription('<Evil>Server', maliciousTools);
    const sanitized = sanitizeDescription(rawDescription);

    // Must not contain raw angle brackets
    expect(sanitized).not.toContain('<');
    expect(sanitized).not.toContain('>');
    // Must not contain XML-like closing tags
    expect(sanitized).not.toMatch(/<\/[a-z_]+>/);
  });

  it('heuristic descriptions with control characters are sanitized', () => {
    const tools = [mockTool('tool_\x00inject\x1f_bad', 'desc\x07')];
    const rawDescription = generateHeuristicDescription('Server', tools);
    const sanitized = sanitizeDescription(rawDescription);

    // No control characters should survive
    // eslint-disable-next-line no-control-regex
    expect(sanitized).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it('sanitizeDescription is idempotent', () => {
    const input = 'Web scraping and <crawling> for data extraction.';
    const once = sanitizeDescription(input);
    const twice = sanitizeDescription(once);
    expect(once).toBe(twice);
  });

  it('sanitized descriptions preserve semantic meaning', () => {
    const input = 'Web scraping, crawling, and structured data extraction from websites.';
    const result = sanitizeDescription(input);
    // Normal descriptions should pass through unchanged
    expect(result).toBe(input);
  });
});
