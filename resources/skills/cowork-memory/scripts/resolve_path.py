#!/usr/bin/env python3
"""Resolve the Sqowe Pilot memory directory path for a given project cwd.

Usage:
    python resolve_path.py <cwd>

Prints the absolute path to the memory directory.
The directory may not exist yet — callers decide whether to create it.

Encoding: absolute cwd path with os.sep replaced by '-'.
  /Users/alice/src/myapp  →  -Users-alice-src-myapp
  C:\\Users\\alice\\myapp  →  -C-Users-alice-myapp
"""

import os
import sys
import platform


def get_base_memory_dir() -> str:
    """Return the platform-appropriate base directory for cowork memory."""
    system = platform.system()
    if system == "Darwin":
        return os.path.join(
            os.path.expanduser("~"),
            "Library",
            "Application Support",
            "sqowe-pilot",
            "memory",
        )
    elif system == "Windows":
        appdata = os.environ.get("APPDATA", os.path.join(os.path.expanduser("~"), "AppData", "Roaming"))
        return os.path.join(appdata, "sqowe-pilot", "memory")
    else:
        # Linux / WSL
        xdg = os.environ.get("XDG_CONFIG_HOME", os.path.join(os.path.expanduser("~"), ".config"))
        return os.path.join(xdg, "sqowe-pilot", "memory")


def encode_cwd(cwd: str) -> str:
    """Encode an absolute path into a directory-safe name."""
    # Normalize and resolve to absolute
    resolved = os.path.realpath(os.path.abspath(cwd))
    # Replace separators with '-'
    encoded = resolved.replace(os.sep, "-")
    # On Windows, also strip the colon from drive letter (C: → C)
    if platform.system() == "Windows" and len(encoded) > 1 and encoded[1] == ":":
        encoded = encoded[0] + encoded[2:]
    return encoded


def resolve_memory_path(cwd: str) -> str:
    """Return the full path to the memory directory for the given cwd."""
    return os.path.join(get_base_memory_dir(), encode_cwd(cwd))


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: resolve_path.py <cwd>", file=sys.stderr)
        sys.exit(2)
    cwd = sys.argv[1]
    print(resolve_memory_path(cwd))


if __name__ == "__main__":
    main()
