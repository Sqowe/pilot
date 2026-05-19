#!/usr/bin/env python3
"""
Claude CoWork Memory MCP Server

Reads memory files from Claude CoWork (Anthropic desktop app) spaces
and exposes them as MCP tools. This allows Open Cowork, Kiro, or any
MCP client to access knowledge accumulated in Claude CoWork sessions.

Storage layout (macOS):
  ~/Library/Application Support/Claude/local-agent-mode-sessions/
    <app-id>/<profile-id>/
      ├── memory/CLAUDE.md          (global rules)
      ├── spaces.json               (space definitions)
      └── spaces/<space-id>/memory/ (per-space memory files)

Usage:
  python server.py

Environment variables:
  COWORK_BASE_PATH   — Override base path to Claude CoWork sessions directory.
  COWORK_PROFILE_ID  — Explicit profile UUID to use (skips auto-discovery).
"""

import json
import os
import platform
import re
from pathlib import Path
from typing import Optional

from fastmcp import FastMCP

# ---------------------------------------------------------------------------
# Configuration & Helpers
# ---------------------------------------------------------------------------


def _get_default_base_path() -> Path:
    """Return the platform-appropriate base path for Claude CoWork sessions."""
    system = platform.system()
    if system == "Darwin":
        return Path.home() / "Library" / "Application Support" / "Claude" / "local-agent-mode-sessions"
    elif system == "Windows":
        appdata = os.environ.get("APPDATA", str(Path.home() / "AppData" / "Roaming"))
        return Path(appdata) / "Claude" / "local-agent-mode-sessions"
    else:
        return Path.home() / ".config" / "Claude" / "local-agent-mode-sessions"


def _find_profile_dir(base: Path) -> Optional[Path]:
    """
    Find the profile directory inside the base path.
    Structure: base/<app-id>/<profile-id>/

    Selection strategy (deterministic):
    1. If COWORK_PROFILE_ID env var is set, look for that specific profile.
    2. Otherwise, collect all valid candidates (dirs containing spaces.json),
       sort by spaces.json mtime descending, and pick the most recently modified.

    Skips unreadable directories gracefully.
    """
    if not base.is_dir():
        return None

    # If explicit profile ID is provided, find it directly
    explicit_profile = os.environ.get("COWORK_PROFILE_ID")

    candidates: list[tuple[float, Path]] = []

    try:
        app_dirs = sorted(base.iterdir())
    except (OSError, PermissionError):
        return None

    for app_dir in app_dirs:
        if not app_dir.is_dir() or app_dir.name == "skills-plugin":
            continue
        try:
            profile_dirs = sorted(app_dir.iterdir())
        except (OSError, PermissionError):
            continue  # Skip unreadable app directories
        for profile_dir in profile_dirs:
            if not profile_dir.is_dir():
                continue
            spaces_file = profile_dir / "spaces.json"
            if not spaces_file.exists():
                continue

            # If explicit profile requested, match by name
            if explicit_profile and profile_dir.name == explicit_profile:
                return profile_dir

            try:
                mtime = spaces_file.stat().st_mtime
            except (OSError, PermissionError):
                continue  # Skip if we can't stat
            candidates.append((mtime, profile_dir))

    if explicit_profile:
        # Explicit profile was requested but not found
        return None

    if not candidates:
        return None

    # Return the most recently modified profile (deterministic tie-breaking by path)
    candidates.sort(key=lambda x: (-x[0], str(x[1])))
    return candidates[0][1]


def _get_profile_dir() -> Path:
    """Resolve and validate the profile directory. Raises FileNotFoundError on failure."""
    env_path = os.environ.get("COWORK_BASE_PATH")
    base = Path(os.path.expanduser(env_path)) if env_path else _get_default_base_path()
    profile = _find_profile_dir(base)
    if profile is None:
        raise FileNotFoundError(
            f"Claude CoWork profile not found under {base}. "
            "Ensure the Claude desktop app with CoWork mode is installed and has been used at least once. "
            "You can also set COWORK_PROFILE_ID to specify the profile UUID explicitly."
        )
    return profile


def _load_spaces(profile_dir: Path) -> list[dict]:
    """Load spaces.json and return the validated spaces list.

    Raises OSError if the file exists but cannot be parsed or read,
    or if the top-level JSON structure is not the expected format.
    Returns an empty list if the file does not exist.

    Individual space entries that are not dicts are silently skipped.
    The 'folders' field is normalized to an empty list if missing or invalid.
    """
    spaces_file = profile_dir / "spaces.json"
    if not spaces_file.exists():
        return []
    try:
        with open(spaces_file, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError, UnicodeDecodeError) as e:
        raise OSError(f"Failed to read spaces.json: {e}") from e

    if not isinstance(data, dict):
        raise OSError(
            f"Failed to read spaces.json: expected JSON object at top level, got {type(data).__name__}"
        )
    raw_spaces = data.get("spaces", [])
    if not isinstance(raw_spaces, list):
        raise OSError(
            f"Failed to read spaces.json: expected 'spaces' to be an array, got {type(raw_spaces).__name__}"
        )

    # Normalize and validate each space entry
    validated: list[dict] = []
    for entry in raw_spaces:
        if not isinstance(entry, dict):
            continue  # Skip non-dict entries
        # Normalize folders to a list of dicts
        folders = entry.get("folders", [])
        if not isinstance(folders, list):
            entry["folders"] = []
        else:
            entry["folders"] = [f for f in folders if isinstance(f, dict)]
        validated.append(entry)
    return validated


# Strict pattern for space IDs: UUID-like or alphanumeric with hyphens/underscores
_VALID_SPACE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")


def _is_valid_space_id(space_id: str) -> bool:
    """Validate that a space_id is safe to use as a path component."""
    if not space_id:
        return False
    return _VALID_SPACE_ID_RE.match(space_id) is not None


def _resolve_space(profile_dir: Path, spaces: list[dict], workspace_path: str) -> Optional[tuple[dict, Path]]:
    """
    Match a workspace path to a CoWork space.
    Returns (space_dict, memory_dir_path) or None if no match.
    Skips folder entries with empty/missing paths and handles resolution errors gracefully.
    Validates space_id and ensures memory_dir stays within the profile's spaces directory.

    When multiple spaces match (overlapping folders), returns the most specific match
    (longest/deepest folder path).
    """
    try:
        target = Path(os.path.expanduser(workspace_path)).resolve()
    except (OSError, RuntimeError):
        return None

    spaces_root = profile_dir / "spaces"

    # Collect all valid matches with their folder path length for specificity ranking
    candidates: list[tuple[int, dict, Path]] = []

    for sp in spaces:
        for folder in sp.get("folders", []):
            raw_path = folder.get("path", "")
            if not raw_path or not raw_path.strip():
                continue  # Skip empty/missing folder paths
            try:
                folder_path = Path(raw_path).resolve()
            except (OSError, RuntimeError):
                continue  # Skip unresolvable paths
            if target == folder_path or folder_path in target.parents:
                space_id = sp.get("id", "")
                # Validate space_id format
                if not _is_valid_space_id(space_id):
                    continue  # Skip spaces with invalid IDs
                memory_dir = profile_dir / "spaces" / space_id / "memory"
                # Enforce memory_dir resolves within the spaces root
                try:
                    memory_dir.resolve().relative_to(spaces_root.resolve())
                except (ValueError, OSError, RuntimeError):
                    continue  # Skip if path escapes profile
                # Use folder path part count as specificity score (deeper = more specific)
                specificity = len(folder_path.parts)
                candidates.append((specificity, sp, memory_dir))

    if not candidates:
        return None

    # Return the most specific match (longest folder path)
    candidates.sort(key=lambda x: -x[0])
    _, best_space, best_memory_dir = candidates[0]
    return best_space, best_memory_dir


def _is_safe_path(memory_dir: Path, target: Path) -> bool:
    """
    Check that a resolved path is within memory_dir and is not a symlink escaping it.
    Returns False on any resolution error (e.g., symlink loops, permission issues).
    """
    try:
        resolved_target = target.resolve()
        resolved_base = memory_dir.resolve()
        resolved_target.relative_to(resolved_base)
    except (ValueError, OSError, RuntimeError):
        return False
    return True


def _safe_read(memory_dir: Path, filename: str) -> Optional[str]:
    """
    Read a file from memory_dir with path-traversal and symlink protection.
    Returns None if the file is invalid, missing, or escapes the boundary.
    All filesystem operations are guarded against OSError/PermissionError.
    """
    target = memory_dir / filename
    if not _is_safe_path(memory_dir, target):
        return None
    try:
        if not target.resolve().is_file():
            return None
    except (OSError, RuntimeError, PermissionError):
        return None
    try:
        return target.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError, PermissionError):
        return None


def _safe_read_all(memory_dir: Path) -> list[tuple[str, str]]:
    """
    Read all .md files from memory_dir with path-boundary protection.
    Returns list of (filename, content) tuples. Skips files that fail safety checks.
    Returns empty list if the directory is missing, unreadable, or iteration fails.
    """
    if not memory_dir.is_dir():
        return []

    results: list[tuple[str, str]] = []
    try:
        entries = sorted(memory_dir.iterdir())
    except (OSError, PermissionError):
        return []

    for f in entries:
        if not f.is_file() or not f.name.endswith(".md"):
            continue
        if not _is_safe_path(memory_dir, f):
            continue  # Skip symlinks escaping the directory
        try:
            content = f.read_text(encoding="utf-8")
            results.append((f.name, content))
        except (OSError, UnicodeDecodeError):
            continue  # Skip unreadable files
    return results


# ---------------------------------------------------------------------------
# MCP Server
# ---------------------------------------------------------------------------

mcp = FastMCP(
    name="claude-cowork-memory",
    instructions=(
        "This server provides read-only access to Claude CoWork (Anthropic desktop app) memory. "
        "Use it to retrieve knowledge accumulated in Claude CoWork sessions — "
        "project context, learned patterns, user preferences, and per-space instructions. "
        "Call cowork_list_spaces to discover available spaces, then use "
        "cowork_find_space or cowork_read_memory to access specific memory."
    ),
)


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


@mcp.tool(
    annotations={"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
)
def cowork_list_spaces() -> str:
    """
    List all Claude CoWork spaces with their names, folder paths, instructions, and memory status.
    Use this first to discover what projects/spaces exist.
    """
    try:
        profile_dir = _get_profile_dir()
        spaces = _load_spaces(profile_dir)
    except (FileNotFoundError, OSError) as e:
        return f"Error: {e}"

    if not spaces:
        return "No spaces found in Claude CoWork."

    lines = []
    for sp in spaces:
        if not isinstance(sp, dict):
            continue  # Extra safety (should be filtered by _load_spaces)
        name = sp.get("name", "unnamed")
        folders_list = sp.get("folders", [])
        folders = [f.get("path", "") for f in folders_list if isinstance(f, dict)]
        instructions = (sp.get("instructions") or "").strip()
        space_id = sp.get("id", "")

        # Only probe filesystem if space_id is valid and contained
        has_memory = False
        if _is_valid_space_id(space_id):
            memory_dir = profile_dir / "spaces" / space_id / "memory"
            try:
                # Enforce containment before probing
                spaces_root = profile_dir / "spaces"
                memory_dir.resolve().relative_to(spaces_root.resolve())
                has_memory = memory_dir.is_dir() and any(memory_dir.iterdir())
            except (ValueError, OSError, RuntimeError):
                pass

        lines.append(f"## {name}")
        lines.append(f"- ID: {space_id}")
        lines.append(f"- Folders: {', '.join(folders) if folders else 'none'}")
        if instructions:
            lines.append(f"- Instructions: {instructions[:200]}")
        lines.append(f"- Has memory: {'yes' if has_memory else 'no'}")
        lines.append("")

    return "\n".join(lines)


@mcp.tool(
    annotations={"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
)
def cowork_find_space(workspace_path: str) -> str:
    """
    Find the Claude CoWork space matching a workspace folder path.
    Returns space name, ID, instructions, and available memory files.

    Args:
        workspace_path: Absolute path to the workspace folder
            (e.g., /Users/eobomik/Documents/Claude/Projects/Investments)
    """
    try:
        profile_dir = _get_profile_dir()
        spaces = _load_spaces(profile_dir)
    except (FileNotFoundError, OSError) as e:
        return f"Error: {e}"

    result = _resolve_space(profile_dir, spaces, workspace_path)
    if result is None:
        return (
            f"No Claude CoWork space found matching: {workspace_path}\n"
            "Hint: use cowork_list_spaces to see all available spaces and their folder paths."
        )

    sp, memory_dir = result
    memory_files: list[str] = []
    try:
        if memory_dir.is_dir():
            memory_files = sorted(
                f.name for f in memory_dir.iterdir()
                if f.is_file() and _is_safe_path(memory_dir, f)
            )
    except OSError:
        pass

    lines = [
        f"Space: {sp.get('name', 'unnamed')}",
        f"ID: {sp.get('id', '')}",
    ]
    folders = sp.get("folders") or []
    folder_display = folders[0].get("path", "") if folders and isinstance(folders[0], dict) else ""
    lines.append(f"Folder: {folder_display}")
    if sp.get("instructions"):
        lines.append(f"Instructions: {sp['instructions']}")
    lines.append(f"Memory files ({len(memory_files)}): {', '.join(memory_files) if memory_files else 'none'}")
    return "\n".join(lines)


@mcp.tool(
    annotations={"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
)
def cowork_read_memory(workspace_path: str, file: str = "MEMORY.md") -> str:
    """
    Read a specific memory file from the Claude CoWork space matching the workspace path.

    Args:
        workspace_path: Absolute path to the workspace folder.
        file: Name of the memory file to read (default: MEMORY.md).
              Use cowork_find_space to see available files.
    """
    try:
        profile_dir = _get_profile_dir()
        spaces = _load_spaces(profile_dir)
    except (FileNotFoundError, OSError) as e:
        return f"Error: {e}"

    result = _resolve_space(profile_dir, spaces, workspace_path)
    if result is None:
        return (
            f"No Claude CoWork space found matching: {workspace_path}\n"
            "Hint: use cowork_list_spaces to see all available spaces."
        )

    sp, memory_dir = result
    content = _safe_read(memory_dir, file)
    if content is None:
        available: list[str] = []
        try:
            if memory_dir.is_dir():
                available = sorted(
                    f.name for f in memory_dir.iterdir()
                    if f.is_file() and _is_safe_path(memory_dir, f)
                )
        except OSError:
            pass
        return (
            f"File '{file}' not found in space '{sp.get('name')}'.\n"
            f"Available files: {', '.join(available) if available else 'none'}"
        )

    return f"# {sp.get('name', 'unnamed')} — {file}\n\n{content}"


@mcp.tool(
    annotations={"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
)
def cowork_read_all_memory(workspace_path: str) -> str:
    """
    Read ALL memory files from the Claude CoWork space matching the workspace path.
    Returns MEMORY.md (index) followed by all topic files, separated by ----.
    Useful for loading full project context at session start.

    Args:
        workspace_path: Absolute path to the workspace folder.
    """
    try:
        profile_dir = _get_profile_dir()
        spaces = _load_spaces(profile_dir)
    except (FileNotFoundError, OSError) as e:
        return f"Error: {e}"

    result = _resolve_space(profile_dir, spaces, workspace_path)
    if result is None:
        return (
            f"No Claude CoWork space found matching: {workspace_path}\n"
            "Hint: use cowork_list_spaces to see all available spaces."
        )

    sp, memory_dir = result
    all_files = _safe_read_all(memory_dir)
    if not all_files:
        return f"No readable memory files for space '{sp.get('name')}'."

    sections = []
    # MEMORY.md first (it's the index)
    for name, content in all_files:
        if name == "MEMORY.md":
            sections.append(f"## MEMORY.md (index)\n\n{content}")
            break

    # All other files
    for name, content in all_files:
        if name != "MEMORY.md":
            sections.append(f"## {name}\n\n{content}")

    header = f"# Claude CoWork Memory — {sp.get('name', 'unnamed')}\n\n"
    return header + "\n\n---\n\n".join(sections)


@mcp.tool(
    annotations={"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
)
def cowork_global_memory() -> str:
    """
    Read the global CLAUDE.md from Claude CoWork.
    Contains rules and instructions that apply to ALL CoWork sessions (not space-specific).
    """
    try:
        profile_dir = _get_profile_dir()
    except FileNotFoundError as e:
        return f"Error: {e}"

    global_memory = profile_dir / "memory" / "CLAUDE.md"
    if not _is_safe_path(profile_dir / "memory", global_memory):
        return "Error: path safety check failed for global CLAUDE.md."
    try:
        if not global_memory.resolve().is_file():
            return "No global CLAUDE.md found in Claude CoWork."
    except (OSError, RuntimeError, PermissionError):
        return "No global CLAUDE.md found in Claude CoWork (access error)."

    try:
        content = global_memory.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError, PermissionError) as e:
        return f"Error reading global CLAUDE.md: {e}"

    return f"# Claude CoWork — Global Memory (CLAUDE.md)\n\n{content}"


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    mcp.run()
