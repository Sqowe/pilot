---
name: cowork-memory
description: "Persistent project memory for Sqowe Pilot sessions — stores notes, learnings, and project context as markdown files that survive across sessions. Use this skill whenever the user says 'remember this', 'save to memory', 'note for next time', asks 'what do you remember about this project?', or when starting a new session on a project that may have prior memory. Also trigger when the agent discovers a useful pattern, build command, or debugging insight worth persisting, or when the user asks to list, search, read, or clear project memory. Activate proactively for any mention of: cowork memory, project memory, MEMORY.md, persistent context, cross-session notes, recall, forget."
---

# Cowork Memory

## How it works

Memory is stored as markdown files on disk, keyed by the project's working
directory. Each project gets its own memory folder at:

```
~/Library/Application Support/sqowe-pilot/memory/<encoded-cwd>/
```

On Linux/WSL the base is `~/.config/sqowe-pilot/memory/<encoded-cwd>/`.
On Windows it's `%APPDATA%/sqowe-pilot/memory/<encoded-cwd>/`.

The `<encoded-cwd>` is the absolute path with path separators replaced by `-`
(e.g. `/Users/alice/src/myapp` → `-Users-alice-src-myapp`).

Inside each project memory folder:

- `MEMORY.md` — the main index, loaded first. Keep it concise (<200 lines).
- Topic files like `debugging.md`, `architecture.md` — for detailed notes.

## Available scripts

All scripts are in `scripts/` relative to this skill. Run with Python 3.9+
(stdlib only, no dependencies).

### resolve_path.py

Resolve the memory directory path for a given project cwd.

```bash
python scripts/resolve_path.py <cwd>
```

Prints the absolute path to the memory directory (may not exist yet).

### read_memory.py

Read memory files for a project.

```bash
# Read MEMORY.md (default)
python scripts/read_memory.py <cwd>

# Read a specific topic file
python scripts/read_memory.py <cwd> --file debugging.md

# Read all files concatenated
python scripts/read_memory.py <cwd> --all
```

Outputs the file content to stdout. Exits 0 if found, 1 if no memory exists.

### list_memory.py

List all memory files for a project.

```bash
python scripts/list_memory.py <cwd>
```

Outputs JSON: `{"exists": true, "path": "...", "files": [{"name": "MEMORY.md", "size": 1234, "modified": "..."}]}`.

### write_memory.py

Write or append to memory files.

```bash
# Append a note to MEMORY.md
python scripts/write_memory.py <cwd> --append "Build: npm run dev starts Vite on port 3000"

# Append to a topic file
python scripts/write_memory.py <cwd> --file debugging.md --append "Redis must be running for API tests"

# Replace entire file content (use with care)
python scripts/write_memory.py <cwd> --file architecture.md --content "# Architecture\n\n..."

# Read content from stdin (for large writes)
echo "# Notes" | python scripts/write_memory.py <cwd> --file notes.md --stdin
```

Creates the memory directory and file if they don't exist.

## Best practices

- Keep MEMORY.md as a concise index (<200 lines, <25 KB)
- Move detailed notes into topic files
- Use `--append` for incremental additions, `--content` for full rewrites
- Prefix entries with `- ` for bullet-style notes
- The agent should read memory at the start of a session when working on a
  known project, and save useful discoveries before the session ends

## Changelog

### v1.1.0 — 2026-05-22

- `read_memory.py` now outputs a message to stdout when no memory exists,
  so the agent sees useful info even when stderr is suppressed (`2>/dev/null`).
  Previously this case produced `(no output)` + exit code 1, which looked
  like a broken command rather than an empty-memory state.
