/**
 * Tests for MCP tool permission resolution and classification.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseMcpToolName,
  decideMcpToolPermission,
  loadWorkspaceMcpPermissions,
  recordMcpToolApproval,
  getToolPromotionSuggestion,
  clearToolApprovalCount,
  _clearWorkspacePolicyCache,
  type WorkspaceMcpPermissions,
} from '../src/main/mcp/mcp-tool-permissions';
import {
  isToolLikelyReadOnly,
  getToolShortName,
  canonicalizeMcpServerName,
} from '../src/shared/mcp-tool-classification';
import type { MCPServerConfig } from '../src/main/mcp/mcp-manager';
import {
  decidePermission,
  setPermissionRules,
  rememberAlwaysAllow,
  forgetSessionPermissions,
  setMcpServerConfigLookup,
  setSessionCwd,
} from '../src/main/config/permission-rules-store';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// isToolLikelyReadOnly classification
// ---------------------------------------------------------------------------

describe('isToolLikelyReadOnly', () => {
  it('classifies get_* tools as read-only', () => {
    expect(isToolLikelyReadOnly('get_company_news')).toBe(true);
    expect(isToolLikelyReadOnly('get_bulk_fundamentals')).toBe(true);
  });

  it('classifies list_* tools as read-only', () => {
    expect(isToolLikelyReadOnly('list_exchanges')).toBe(true);
    expect(isToolLikelyReadOnly('list_network_requests')).toBe(true);
  });

  it('classifies search_* tools as read-only', () => {
    expect(isToolLikelyReadOnly('search_documents')).toBe(true);
  });

  it('classifies exact matches as read-only', () => {
    expect(isToolLikelyReadOnly('ping')).toBe(true);
    expect(isToolLikelyReadOnly('status')).toBe(true);
    expect(isToolLikelyReadOnly('version')).toBe(true);
  });

  it('classifies write indicators as NOT read-only', () => {
    expect(isToolLikelyReadOnly('create_project')).toBe(false);
    expect(isToolLikelyReadOnly('delete_record')).toBe(false);
    expect(isToolLikelyReadOnly('execute_trade')).toBe(false);
    expect(isToolLikelyReadOnly('send_email')).toBe(false);
    expect(isToolLikelyReadOnly('capture_realtime_ws')).toBe(false);
  });

  it('write indicators take priority over read prefixes', () => {
    // Hypothetical tool that starts with a write indicator
    expect(isToolLikelyReadOnly('update_cache')).toBe(false);
  });

  it('unknown tools default to NOT read-only (conservative)', () => {
    expect(isToolLikelyReadOnly('do_something')).toBe(false);
    expect(isToolLikelyReadOnly('process_data')).toBe(false);
    expect(isToolLikelyReadOnly('navigate_page')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isToolLikelyReadOnly('GET_DATA')).toBe(true);
    expect(isToolLikelyReadOnly('List_Items')).toBe(true);
    expect(isToolLikelyReadOnly('DELETE_Record')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseMcpToolName
// ---------------------------------------------------------------------------

describe('parseMcpToolName', () => {
  it('parses standard MCP tool names', () => {
    expect(parseMcpToolName('mcp__EODHD__get_company_news')).toEqual({
      serverName: 'EODHD',
      toolName: 'get_company_news',
    });
  });

  it('handles server names with underscores', () => {
    expect(parseMcpToolName('mcp__Software_Development__read_file')).toEqual({
      serverName: 'Software_Development',
      toolName: 'read_file',
    });
  });

  it('returns null for non-MCP tool names', () => {
    expect(parseMcpToolName('read')).toBeNull();
    expect(parseMcpToolName('bash')).toBeNull();
    expect(parseMcpToolName('write')).toBeNull();
  });

  it('returns null for malformed MCP names (no second separator)', () => {
    expect(parseMcpToolName('mcp__ServerOnly')).toBeNull();
  });

  it('handles tool names with double underscores', () => {
    const result = parseMcpToolName('mcp__Server__tool__with__underscores');
    expect(result).toEqual({
      serverName: 'Server',
      toolName: 'tool__with__underscores',
    });
  });
});

// ---------------------------------------------------------------------------
// getToolShortName
// ---------------------------------------------------------------------------

describe('getToolShortName', () => {
  it('extracts short name from full MCP name', () => {
    expect(getToolShortName('mcp__EODHD__get_company_news')).toBe('get_company_news');
  });

  it('returns input unchanged for non-MCP names', () => {
    expect(getToolShortName('read')).toBe('read');
  });
});

// ---------------------------------------------------------------------------
// canonicalizeMcpServerName
// ---------------------------------------------------------------------------

describe('canonicalizeMcpServerName', () => {
  it('collapses whitespace to single underscore', () => {
    expect(canonicalizeMcpServerName('My Server')).toBe('My_Server');
    expect(canonicalizeMcpServerName('My  Server')).toBe('My_Server');
    expect(canonicalizeMcpServerName('My\tServer')).toBe('My_Server');
  });

  it('collapses double underscores to single', () => {
    expect(canonicalizeMcpServerName('My__Server')).toBe('My_Server');
    // All runs of underscores collapse to single (delimiter-safe)
    expect(canonicalizeMcpServerName('My____Server')).toBe('My_Server');
  });

  it('handles combined whitespace and underscores', () => {
    // 'My  __Server' → whitespace collapse → 'My___Server' → underscore collapse → 'My_Server'
    expect(canonicalizeMcpServerName('My  __Server')).toBe('My_Server');
  });

  it('preserves case', () => {
    expect(canonicalizeMcpServerName('EODHD')).toBe('EODHD');
    expect(canonicalizeMcpServerName('Software Development')).toBe('Software_Development');
  });

  it('handles already-clean names', () => {
    expect(canonicalizeMcpServerName('Chrome')).toBe('Chrome');
    expect(canonicalizeMcpServerName('GUI_Operate')).toBe('GUI_Operate');
  });
});

// ---------------------------------------------------------------------------
// decideMcpToolPermission — precedence
// ---------------------------------------------------------------------------

describe('decideMcpToolPermission', () => {
  const baseServer: MCPServerConfig = {
    id: 'test-server',
    name: 'TestServer',
    type: 'stdio',
    enabled: true,
  };

  it('returns null when no policy is configured', () => {
    expect(decideMcpToolPermission(baseServer, 'get_data')).toBeNull();
  });

  it('returns null when server config is undefined', () => {
    expect(decideMcpToolPermission(undefined, 'get_data')).toBeNull();
  });

  // Server default policy
  it('allow-all policy allows any tool', () => {
    const server = { ...baseServer, defaultToolPolicy: 'allow-all' as const };
    expect(decideMcpToolPermission(server, 'get_data')).toBe('allow');
    expect(decideMcpToolPermission(server, 'delete_record')).toBe('allow');
  });

  it('deny-all policy denies any tool', () => {
    const server = { ...baseServer, defaultToolPolicy: 'deny-all' as const };
    expect(decideMcpToolPermission(server, 'get_data')).toBe('deny');
    expect(decideMcpToolPermission(server, 'delete_record')).toBe('deny');
  });

  it('ask-all policy asks for any tool', () => {
    const server = { ...baseServer, defaultToolPolicy: 'ask-all' as const };
    expect(decideMcpToolPermission(server, 'get_data')).toBe('ask');
    expect(decideMcpToolPermission(server, 'delete_record')).toBe('ask');
  });

  it('allow-reads allows read-only tools and asks for write tools', () => {
    const server = { ...baseServer, defaultToolPolicy: 'allow-reads' as const };
    expect(decideMcpToolPermission(server, 'get_data')).toBe('allow');
    expect(decideMcpToolPermission(server, 'list_items')).toBe('allow');
    expect(decideMcpToolPermission(server, 'delete_record')).toBe('ask');
    expect(decideMcpToolPermission(server, 'execute_trade')).toBe('ask');
  });

  // Per-tool override takes priority over server default
  it('per-tool override overrides server default', () => {
    const server = {
      ...baseServer,
      defaultToolPolicy: 'allow-all' as const,
      toolPermissions: { delete_record: 'deny' as const },
    };
    expect(decideMcpToolPermission(server, 'delete_record')).toBe('deny');
    expect(decideMcpToolPermission(server, 'get_data')).toBe('allow'); // no override
  });

  // Workspace policy takes highest priority
  it('workspace policy overrides per-tool and server default', () => {
    const server = {
      ...baseServer,
      defaultToolPolicy: 'allow-all' as const,
      toolPermissions: { get_data: 'allow' as const },
    };
    const workspacePolicy: WorkspaceMcpPermissions = {
      TestServer: {
        overrides: { get_data: 'deny' },
      },
    };
    // Trusted workspace: deny override is honoured
    expect(decideMcpToolPermission(server, 'get_data', workspacePolicy, true)).toBe('deny');
  });

  it('workspace default policy overrides server default', () => {
    const server = {
      ...baseServer,
      defaultToolPolicy: 'allow-all' as const,
    };
    const workspacePolicy: WorkspaceMcpPermissions = {
      TestServer: {
        defaultPolicy: 'ask-all',
      },
    };
    expect(decideMcpToolPermission(server, 'get_data', workspacePolicy, true)).toBe('ask');
  });

  it('workspace per-tool override takes priority over workspace default', () => {
    const workspacePolicy: WorkspaceMcpPermissions = {
      TestServer: {
        defaultPolicy: 'deny-all',
        overrides: { get_data: 'allow' },
      },
    };
    // Trusted workspace: allow is honoured
    expect(decideMcpToolPermission(baseServer, 'get_data', workspacePolicy, true)).toBe('allow');
    expect(decideMcpToolPermission(baseServer, 'other_tool', workspacePolicy, true)).toBe('deny');
  });

  // Workspace trust boundary tests
  it('untrusted workspace cannot grant allow via per-tool override', () => {
    const workspacePolicy: WorkspaceMcpPermissions = {
      TestServer: {
        overrides: { dangerous_tool: 'allow' },
      },
    };
    // Untrusted: 'allow' is downgraded to 'ask'
    expect(decideMcpToolPermission(baseServer, 'dangerous_tool', workspacePolicy, false)).toBe(
      'ask'
    );
  });

  it('untrusted workspace cannot grant allow via default policy', () => {
    const workspacePolicy: WorkspaceMcpPermissions = {
      TestServer: {
        defaultPolicy: 'allow-all',
      },
    };
    // Untrusted: 'allow' from allow-all is downgraded to 'ask'
    expect(decideMcpToolPermission(baseServer, 'get_data', workspacePolicy, false)).toBe('ask');
  });

  it('untrusted workspace can still deny tools', () => {
    const workspacePolicy: WorkspaceMcpPermissions = {
      TestServer: {
        overrides: { get_data: 'deny' },
      },
    };
    // Untrusted: deny is always honoured (restrictive)
    expect(decideMcpToolPermission(baseServer, 'get_data', workspacePolicy, false)).toBe('deny');
  });

  it('trusted workspace can grant allow', () => {
    const workspacePolicy: WorkspaceMcpPermissions = {
      TestServer: {
        defaultPolicy: 'allow-all',
      },
    };
    expect(decideMcpToolPermission(baseServer, 'get_data', workspacePolicy, true)).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// Integration: decidePermission with MCP tool policies
// ---------------------------------------------------------------------------

describe('decidePermission with MCP tool policies', () => {
  beforeEach(() => {
    setPermissionRules([]);
    forgetSessionPermissions('s1');
    // Register a mock MCP server config lookup
    setMcpServerConfigLookup((serverName: string) => {
      if (serverName === 'EODHD') {
        return {
          id: 'eodhd-1',
          name: 'EODHD',
          type: 'stdio' as const,
          enabled: true,
          defaultToolPolicy: 'allow-reads' as const,
          toolPermissions: { execute_trade: 'deny' as const },
        };
      }
      return undefined;
    });
  });

  afterEach(() => {
    forgetSessionPermissions('s1');
    setMcpServerConfigLookup(null as unknown as (name: string) => MCPServerConfig | undefined);
  });

  it('allows read-only MCP tools under allow-reads policy', () => {
    expect(decidePermission('s1', 'mcp__EODHD__get_company_news', {})).toBe('allow');
    expect(decidePermission('s1', 'mcp__EODHD__list_exchanges', {})).toBe('allow');
  });

  it('asks for write MCP tools under allow-reads policy', () => {
    expect(decidePermission('s1', 'mcp__EODHD__capture_realtime_ws', {})).toBe('ask');
  });

  it('denies tools with explicit deny override', () => {
    expect(decidePermission('s1', 'mcp__EODHD__execute_trade', {})).toBe('deny');
  });

  it('session always-allow overrides MCP ask decision', () => {
    // First call should ask
    expect(decidePermission('s1', 'mcp__EODHD__capture_realtime_ws', {})).toBe('ask');
    // User clicks "always allow"
    rememberAlwaysAllow('s1', 'mcp__EODHD__capture_realtime_ws');
    // Now should allow
    expect(decidePermission('s1', 'mcp__EODHD__capture_realtime_ws', {})).toBe('allow');
  });

  it('session always-allow cannot override MCP deny decision', () => {
    rememberAlwaysAllow('s1', 'mcp__EODHD__execute_trade');
    // Deny is authoritative — session memory cannot override it
    expect(decidePermission('s1', 'mcp__EODHD__execute_trade', {})).toBe('deny');
  });

  it('falls through to generic rules for unknown MCP servers', () => {
    // No config for "Unknown" server → MCP engine returns null → falls through to generic rules
    setPermissionRules([{ tool: 'mcp__unknown__some_tool', action: 'allow' }]);
    // Generic rule matches (case-insensitive), so result is 'allow'
    expect(decidePermission('s1', 'mcp__Unknown__some_tool', {})).toBe('allow');
  });

  it('handles servers with spaces in names via canonicalization', () => {
    // Register a server with spaces in the name
    setMcpServerConfigLookup((serverName: string) => {
      if (serverName === 'Software_Development') {
        return {
          id: 'sw-dev-1',
          name: 'Software Development',
          type: 'stdio' as const,
          enabled: true,
          defaultToolPolicy: 'deny-all' as const,
        };
      }
      return undefined;
    });
    // Tool name uses canonicalized server key (spaces → underscore)
    expect(decidePermission('s1', 'mcp__Software_Development__read_file', {})).toBe('deny');
  });

  it('deny policy cannot be bypassed by session always-allow for spaced server names', () => {
    setMcpServerConfigLookup((serverName: string) => {
      if (serverName === 'My_Server') {
        return {
          id: 'my-1',
          name: 'My Server',
          type: 'stdio' as const,
          enabled: true,
          defaultToolPolicy: 'deny-all' as const,
        };
      }
      return undefined;
    });
    rememberAlwaysAllow('s1', 'mcp__My_Server__dangerous_tool');
    // Deny is authoritative — cannot be bypassed
    expect(decidePermission('s1', 'mcp__My_Server__dangerous_tool', {})).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// Progressive trust tracking
// ---------------------------------------------------------------------------

describe('progressive trust tracking', () => {
  const toolName = 'mcp__EODHD__get_company_news';

  beforeEach(() => {
    clearToolApprovalCount(toolName);
  });

  it('returns null when below threshold', () => {
    recordMcpToolApproval(toolName);
    recordMcpToolApproval(toolName);
    expect(getToolPromotionSuggestion(toolName)).toBeNull();
  });

  it('returns count when threshold reached', () => {
    for (let i = 0; i < 5; i++) {
      recordMcpToolApproval(toolName);
    }
    expect(getToolPromotionSuggestion(toolName)).toBe(5);
  });

  it('clearToolApprovalCount resets the counter', () => {
    for (let i = 0; i < 5; i++) {
      recordMcpToolApproval(toolName);
    }
    clearToolApprovalCount(toolName);
    expect(getToolPromotionSuggestion(toolName)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Workspace policy file loading
// ---------------------------------------------------------------------------

describe('loadWorkspaceMcpPermissions', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-perm-test-'));
    _clearWorkspacePolicyCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    _clearWorkspacePolicyCache();
  });

  it('returns null when file does not exist', () => {
    expect(loadWorkspaceMcpPermissions(tmpDir)).toBeNull();
  });

  it('loads valid policy file', () => {
    const coworkDir = path.join(tmpDir, '.cowork');
    fs.mkdirSync(coworkDir, { recursive: true });
    const policy = { TestServer: { defaultPolicy: 'allow-reads' } };
    fs.writeFileSync(path.join(coworkDir, 'mcp-permissions.json'), JSON.stringify(policy));

    const result = loadWorkspaceMcpPermissions(tmpDir);
    expect(result).toEqual(policy);
  });

  it('returns null for invalid JSON', () => {
    const coworkDir = path.join(tmpDir, '.cowork');
    fs.mkdirSync(coworkDir, { recursive: true });
    fs.writeFileSync(path.join(coworkDir, 'mcp-permissions.json'), 'not json');

    expect(loadWorkspaceMcpPermissions(tmpDir)).toBeNull();
  });

  it('returns null for array (invalid structure)', () => {
    const coworkDir = path.join(tmpDir, '.cowork');
    fs.mkdirSync(coworkDir, { recursive: true });
    fs.writeFileSync(path.join(coworkDir, 'mcp-permissions.json'), '[]');

    expect(loadWorkspaceMcpPermissions(tmpDir)).toBeNull();
  });

  it('returns null for policy with only invalid values', () => {
    const coworkDir = path.join(tmpDir, '.cowork');
    fs.mkdirSync(coworkDir, { recursive: true });
    const invalidPolicy = {
      TestServer: {
        defaultPolicy: 'invalid-policy',
        overrides: { tool1: 'block' }, // invalid action
      },
    };
    fs.writeFileSync(path.join(coworkDir, 'mcp-permissions.json'), JSON.stringify(invalidPolicy));

    // All values are invalid → sanitized to null
    expect(loadWorkspaceMcpPermissions(tmpDir)).toBeNull();
  });

  it('strips invalid override values but keeps valid ones', () => {
    const coworkDir = path.join(tmpDir, '.cowork');
    fs.mkdirSync(coworkDir, { recursive: true });
    const mixedPolicy = {
      TestServer: {
        defaultPolicy: 'allow-reads',
        overrides: {
          valid_tool: 'deny',
          invalid_tool: 'block', // invalid
          another_valid: 'allow',
        },
      },
    };
    fs.writeFileSync(path.join(coworkDir, 'mcp-permissions.json'), JSON.stringify(mixedPolicy));

    const result = loadWorkspaceMcpPermissions(tmpDir);
    expect(result).toEqual({
      TestServer: {
        defaultPolicy: 'allow-reads',
        overrides: {
          valid_tool: 'deny',
          another_valid: 'allow',
        },
      },
    });
  });

  it('skips non-object server entries', () => {
    const coworkDir = path.join(tmpDir, '.cowork');
    fs.mkdirSync(coworkDir, { recursive: true });
    const policy = {
      ValidServer: { defaultPolicy: 'ask-all' },
      InvalidServer: 'not an object',
      ArrayServer: [1, 2, 3],
    };
    fs.writeFileSync(path.join(coworkDir, 'mcp-permissions.json'), JSON.stringify(policy));

    const result = loadWorkspaceMcpPermissions(tmpDir);
    expect(result).toEqual({
      ValidServer: { defaultPolicy: 'ask-all' },
    });
  });

  it('caches results and returns same reference on repeated calls', () => {
    const coworkDir = path.join(tmpDir, '.cowork');
    fs.mkdirSync(coworkDir, { recursive: true });
    const policy = { TestServer: { defaultPolicy: 'allow-all' } };
    fs.writeFileSync(path.join(coworkDir, 'mcp-permissions.json'), JSON.stringify(policy));

    const result1 = loadWorkspaceMcpPermissions(tmpDir);
    const result2 = loadWorkspaceMcpPermissions(tmpDir);
    // Same cached reference
    expect(result1).toBe(result2);
  });

  it('reloads when file is modified', () => {
    const coworkDir = path.join(tmpDir, '.cowork');
    fs.mkdirSync(coworkDir, { recursive: true });
    const filePath = path.join(coworkDir, 'mcp-permissions.json');

    const policy1 = { TestServer: { defaultPolicy: 'allow-all' } };
    fs.writeFileSync(filePath, JSON.stringify(policy1));
    const result1 = loadWorkspaceMcpPermissions(tmpDir);
    expect(result1).toEqual(policy1);

    // Modify file and clear cache to simulate TTL expiry
    const policy2 = { TestServer: { defaultPolicy: 'deny-all' } };
    fs.writeFileSync(filePath, JSON.stringify(policy2));
    // Force mtime change (filesystem granularity)
    const stat = fs.statSync(filePath);
    fs.utimesSync(filePath, stat.atime, new Date(stat.mtimeMs + 1000));
    // Clear cache to bypass positive-cache TTL (simulates time passing)
    _clearWorkspacePolicyCache();

    const result2 = loadWorkspaceMcpPermissions(tmpDir);
    expect(result2).toEqual(policy2);
  });
});
