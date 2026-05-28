# Claude CoWork Memory MCP Server

Read-only MCP server that exposes Claude CoWork (Anthropic desktop app) memory to any MCP client — Open Cowork, Kiro, Claude Code, etc.

## What it does

Claude CoWork accumulates knowledge across sessions in per-space memory files (MEMORY.md + topic files). This server makes that knowledge accessible to other tools via MCP.

## Requirements

- Python 3.10+
- `fastmcp` package

## Setup

```bash
cd tools/claude-cowork-memory-mcp
python -m venv .venv
source .venv/bin/activate
pip install fastmcp
```

## Configuration

### Kiro (`~/.kiro/settings/mcp.json`)

```json
{
  "mcpServers": {
    "claude-cowork-memory": {
      "command": "/Users/eobomik/src/open-cowork/tools/claude-cowork-memory-mcp/.venv/bin/python",
      "args": ["/Users/eobomik/src/open-cowork/tools/claude-cowork-memory-mcp/server.py"],
      "autoApprove": [
        "cowork_list_spaces",
        "cowork_find_space",
        "cowork_read_memory",
        "cowork_read_all_memory",
        "cowork_global_memory"
      ]
    }
  }
}
```

### Open Cowork (MCP settings UI or config)

Same command/args pattern — add via the MCP server management UI.

### Claude Code (`~/.claude/.mcp.json`)

```json
{
  "mcpServers": {
    "claude-cowork-memory": {
      "command": "/Users/eobomik/src/open-cowork/tools/claude-cowork-memory-mcp/.venv/bin/python",
      "args": ["/Users/eobomik/src/open-cowork/tools/claude-cowork-memory-mcp/server.py"]
    }
  }
}
```

## Tools

| Tool                     | Description                                                                  |
| ------------------------ | ---------------------------------------------------------------------------- |
| `cowork_list_spaces`     | List all Claude CoWork spaces with names, folders, and memory status         |
| `cowork_find_space`      | Find the CoWork space matching a workspace path, show available memory files |
| `cowork_read_memory`     | Read a specific memory file from a space                                     |
| `cowork_read_all_memory` | Read ALL memory files from a space (full context dump)                       |
| `cowork_global_memory`   | Read the global CLAUDE.md (rules for all sessions)                           |

All tools are read-only (annotated with `readOnlyHint: true`).

## How matching works

The server reads Claude CoWork's `spaces.json` and matches workspace paths:

1. You pass a workspace path (e.g., `/Users/eobomik/Documents/Claude/Projects/Investments`)
2. Server finds the space whose `folders[].path` matches
3. Returns memory from `spaces/<space-id>/memory/`

## Environment variables

| Variable           | Default           | Description                                      |
| ------------------ | ----------------- | ------------------------------------------------ |
| `COWORK_BASE_PATH` | Platform-specific | Override the base path to Claude CoWork sessions |

## Data locations (macOS)

```
~/Library/Application Support/Claude/local-agent-mode-sessions/
└── <app-id>/<profile-id>/
    ├── memory/CLAUDE.md              ← Global rules
    ├── spaces.json                   ← Space definitions
    └── spaces/<space-id>/memory/     ← Per-space memory
        ├── MEMORY.md                 ← Index file
        └── *.md                      ← Topic files
```
