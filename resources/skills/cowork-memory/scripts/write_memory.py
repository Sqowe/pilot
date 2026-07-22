#!/usr/bin/env python3
"""Write or append to Sqowe Pilot project memory files.

Usage:
    # Append a line to MEMORY.md
    python write_memory.py <cwd> --append "Build command: npm run dev"

    # Append to a topic file
    python write_memory.py <cwd> --file debugging.md --append "Redis required for API tests"

    # Replace entire file content
    python write_memory.py <cwd> --file arch.md --content "# Architecture\n\nMonorepo with..."

    # Read content from stdin (for large writes)
    echo "# Notes" | python write_memory.py <cwd> --file notes.md --stdin

Exit codes:
    0 — success
    1 — error (path escape, invalid args)
"""

import argparse
import os
import sys
import tempfile

from resolve_path import resolve_memory_path

# Safety limits
MAX_FILE_SIZE = 256 * 1024  # 256 KB per file
MAX_TOTAL_SIZE = 2 * 1024 * 1024  # 2 MB total per project


def ensure_memory_dir(memory_dir: str) -> None:
    """Create the memory directory if it doesn't exist."""
    os.makedirs(memory_dir, mode=0o700, exist_ok=True)


def check_containment(memory_dir: str, filename: str) -> str:
    """Verify the target file stays inside the memory directory. Returns real path."""
    filepath = os.path.join(memory_dir, filename)
    # Resolve to catch .. and symlink escapes
    real_dir = os.path.realpath(memory_dir)
    real_file = os.path.realpath(os.path.dirname(filepath))
    if not (real_file == real_dir or real_file.startswith(real_dir + os.sep)):
        print(f"Error: path escapes memory directory: {filename}", file=sys.stderr)
        sys.exit(1)
    return os.path.join(real_dir, os.path.basename(filename))


def check_size_limits(memory_dir: str, target_file: str, new_content_len: int) -> None:
    """Enforce per-file and total size limits."""
    # Per-file check
    existing_size = 0
    if os.path.isfile(target_file):
        existing_size = os.path.getsize(target_file)
    if existing_size + new_content_len > MAX_FILE_SIZE:
        print(
            f"Error: file would exceed {MAX_FILE_SIZE // 1024} KB limit. "
            f"Current: {existing_size}, adding: {new_content_len}.",
            file=sys.stderr,
        )
        sys.exit(1)

    # Total project memory check
    total = 0
    if os.path.isdir(memory_dir):
        for name in os.listdir(memory_dir):
            fp = os.path.join(memory_dir, name)
            if os.path.isfile(fp):
                total += os.path.getsize(fp)
    if total + new_content_len > MAX_TOTAL_SIZE:
        print(
            f"Error: total project memory would exceed {MAX_TOTAL_SIZE // (1024 * 1024)} MB limit. "
            f"Current total: {total}.",
            file=sys.stderr,
        )
        sys.exit(1)


def atomic_write(filepath: str, content: str) -> None:
    """Write content atomically using tmp + rename."""
    dirpath = os.path.dirname(filepath)
    fd, tmp_path = tempfile.mkstemp(dir=dirpath, suffix=".tmp", prefix=".mem_")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp_path, filepath)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description="Write Sqowe Pilot project memory")
    parser.add_argument("cwd", help="Project working directory")
    parser.add_argument("--file", "-f", default="MEMORY.md", help="Target file (default: MEMORY.md)")
    parser.add_argument("--append", "-a", help="Text to append as a new line")
    parser.add_argument("--content", "-c", help="Full content to replace the file with")
    parser.add_argument("--stdin", action="store_true", help="Read content from stdin")
    args = parser.parse_args()

    # Validate: exactly one write mode
    modes = sum([bool(args.append), bool(args.content), args.stdin])
    if modes == 0:
        print("Error: specify --append, --content, or --stdin", file=sys.stderr)
        sys.exit(1)
    if modes > 1:
        print("Error: use only one of --append, --content, --stdin", file=sys.stderr)
        sys.exit(1)

    # Only allow .md files
    if not args.file.endswith(".md"):
        print("Error: only .md files are allowed in memory", file=sys.stderr)
        sys.exit(1)

    # No subdirectories
    if os.sep in args.file or "/" in args.file:
        print("Error: subdirectories not allowed in memory files", file=sys.stderr)
        sys.exit(1)

    memory_dir = resolve_memory_path(args.cwd)
    target = check_containment(memory_dir, args.file)

    if args.append:
        new_text = args.append
        check_size_limits(memory_dir, target, len(new_text) + 2)
        ensure_memory_dir(memory_dir)
        with open(target, "a", encoding="utf-8") as f:
            # Add newline before if file exists and doesn't end with one
            if os.path.isfile(target) and os.path.getsize(target) > 0:
                f.seek(0, 2)  # seek end
                # Check last char
                pos = f.tell()
                if pos > 0:
                    with open(target, "r", encoding="utf-8") as rf:
                        rf.seek(max(0, pos - 1))
                        last = rf.read(1)
                        if last != "\n":
                            f.write("\n")
            f.write(new_text + "\n")
        print(f"Appended to {args.file}", file=sys.stderr)

    elif args.content:
        check_size_limits(memory_dir, target, len(args.content))
        ensure_memory_dir(memory_dir)
        atomic_write(target, args.content)
        print(f"Wrote {args.file} ({len(args.content)} bytes)", file=sys.stderr)

    elif args.stdin:
        content = sys.stdin.read()
        check_size_limits(memory_dir, target, len(content))
        ensure_memory_dir(memory_dir)
        atomic_write(target, content)
        print(f"Wrote {args.file} from stdin ({len(content)} bytes)", file=sys.stderr)

    print(target)


if __name__ == "__main__":
    main()
