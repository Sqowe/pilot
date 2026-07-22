#!/usr/bin/env python3
"""Read memory files for an Sqowe Pilot project.

Usage:
    python read_memory.py <cwd>                    # read MEMORY.md
    python read_memory.py <cwd> --file topic.md    # read a specific file
    python read_memory.py <cwd> --all              # read all files concatenated

Exit codes:
    0 — success, content printed to stdout
    1 — no memory directory or file not found
"""

import argparse
import os
import sys

from resolve_path import resolve_memory_path


def read_single(memory_dir: str, filename: str) -> int:
    filepath = os.path.join(memory_dir, filename)
    # Containment check
    real_dir = os.path.realpath(memory_dir)
    real_file = os.path.realpath(filepath)
    if not real_file.startswith(real_dir + os.sep) and real_file != real_dir:
        print(f"Error: path escapes memory directory: {filename}", file=sys.stderr)
        return 1
    if not os.path.isfile(real_file):
        print(f"Not found: {filename}", file=sys.stderr)
        return 1
    with open(real_file, "r", encoding="utf-8") as f:
        print(f.read(), end="")
    return 0


def read_all(memory_dir: str) -> int:
    if not os.path.isdir(memory_dir):
        print("No memory directory found.", file=sys.stderr)
        return 1
    files = sorted(f for f in os.listdir(memory_dir) if f.endswith(".md"))
    if not files:
        print("Memory directory is empty.", file=sys.stderr)
        return 1
    for i, name in enumerate(files):
        # Put MEMORY.md first regardless of sort order
        pass
    # Reorder: MEMORY.md first, then the rest alphabetically
    if "MEMORY.md" in files:
        files.remove("MEMORY.md")
        files.insert(0, "MEMORY.md")
    for i, name in enumerate(files):
        if i > 0:
            print("\n---\n")
        print(f"# [{name}]\n")
        filepath = os.path.join(memory_dir, name)
        with open(filepath, "r", encoding="utf-8") as f:
            print(f.read(), end="")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Read Sqowe Pilot project memory")
    parser.add_argument("cwd", help="Project working directory")
    parser.add_argument("--file", "-f", default="MEMORY.md", help="Specific file to read (default: MEMORY.md)")
    parser.add_argument("--all", "-a", action="store_true", help="Read all memory files")
    args = parser.parse_args()

    memory_dir = resolve_memory_path(args.cwd)

    if not os.path.isdir(memory_dir):
        print(f"No memory found for this project. Memory directory does not exist: {memory_dir}")
        print(f"No memory found for: {args.cwd}", file=sys.stderr)
        sys.exit(1)

    if args.all:
        sys.exit(read_all(memory_dir))
    else:
        sys.exit(read_single(memory_dir, args.file))


if __name__ == "__main__":
    main()
