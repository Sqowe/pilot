#!/usr/bin/env python3
"""List memory files for an Sqowe Pilot project.

Usage:
    python list_memory.py <cwd>

Outputs JSON to stdout:
    {"exists": true, "path": "...", "files": [{"name": "MEMORY.md", "size": 1234, "modified": "2025-..."}]}
"""

import json
import os
import sys
from datetime import datetime, timezone

from resolve_path import resolve_memory_path


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: list_memory.py <cwd>", file=sys.stderr)
        sys.exit(2)

    cwd = sys.argv[1]
    memory_dir = resolve_memory_path(cwd)

    if not os.path.isdir(memory_dir):
        result = {
            "exists": False,
            "path": memory_dir,
            "files": [],
        }
        print(json.dumps(result, indent=2))
        return

    files = []
    for name in sorted(os.listdir(memory_dir)):
        filepath = os.path.join(memory_dir, name)
        if not os.path.isfile(filepath):
            continue
        stat = os.stat(filepath)
        files.append({
            "name": name,
            "size": stat.st_size,
            "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        })

    # Put MEMORY.md first
    files.sort(key=lambda f: (0 if f["name"] == "MEMORY.md" else 1, f["name"]))

    result = {
        "exists": True,
        "path": memory_dir,
        "files": files,
        "total_size": sum(f["size"] for f in files),
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
