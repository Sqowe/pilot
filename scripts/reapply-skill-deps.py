#!/usr/bin/env python3
"""
Re-apply PEP 723 inline dependency metadata to builtin skill scripts.

Run this after updating skills from upstream (Anthropic Claude skills repo)
to restore automatic dependency resolution via `uv run`.

Usage:
    python3 scripts/reapply-skill-deps.py [--check] [--verbose]

Flags:
    --check    Dry-run mode: report what would change without modifying files
    --verbose  Print details for each file processed

See AI_SKILLS_MAINTENANCE.md for full context.
"""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SKILLS_DIR = PROJECT_ROOT / "resources" / "skills"

# Map: (skill_name, script_name) -> list of PyPI package names
DEPENDENCY_MAP = {
    ("pdf", "check_fillable_fields.py"): ["pypdf"],
    ("pdf", "convert_pdf_to_images.py"): ["pdf2image"],
    ("pdf", "create_validation_image.py"): ["Pillow"],
    ("pdf", "extract_form_field_info.py"): ["pypdf"],
    ("pdf", "extract_form_structure.py"): ["pdfplumber"],
    ("pdf", "fill_fillable_fields.py"): ["pypdf"],
    ("pdf", "fill_pdf_form_with_annotations.py"): ["pypdf"],
    ("pptx", "clean.py"): ["defusedxml"],
    ("pptx", "thumbnail.py"): ["defusedxml", "Pillow"],
    ("xlsx", "recalc.py"): ["openpyxl"],
    ("docx", "comment.py"): ["defusedxml"],
    ("skill-creator", "quick_validate.py"): ["pyyaml"],
}

PEP723_MARKER = "# /// script"
PEP723_END = "# ///"


def build_metadata_block(deps: list[str]) -> str:
    """Build the PEP 723 inline script metadata block."""
    deps_str = ", ".join(f'"{d}"' for d in deps)
    return f"# /// script\n# dependencies = [{deps_str}]\n# ///\n"


def find_metadata_block(content: str) -> tuple[int, int] | None:
    """Find valid PEP 723 metadata block in the file header area.

    Only searches the first ~20 lines (after optional shebang and encoding comment).
    Returns (start_line_index, end_line_index) if a complete block is found,
    or None if no valid block exists.
    """
    lines = content.split("\n")
    # PEP 723 metadata must appear in the header area (first 20 lines)
    search_limit = min(20, len(lines))
    start_idx = None

    for i in range(search_limit):
        stripped = lines[i].strip()
        if stripped == PEP723_MARKER.strip():
            start_idx = i
            continue
        if start_idx is not None and stripped == PEP723_END.strip():
            return (start_idx, i)

    # No complete block found (or unterminated block)
    return None


def has_metadata(content: str) -> bool:
    """Check if file has a valid PEP 723 metadata block in the header area."""
    return find_metadata_block(content) is not None


def strip_existing_metadata(content: str) -> str:
    """Remove existing PEP 723 metadata block from content.

    Only removes if a complete block (start + end markers) exists in the header.
    Returns content unchanged if no valid block is found.
    """
    block = find_metadata_block(content)
    if block is None:
        return content

    start_idx, end_idx = block
    lines = content.split("\n")
    # Remove the block lines
    result = lines[:start_idx] + lines[end_idx + 1:]
    # Remove leading blank lines that were immediately after the metadata
    while result and start_idx < len(result) and result[start_idx] == "":
        result.pop(start_idx)
    return "\n".join(result)


def apply_metadata(file_path: Path, deps: list[str], check: bool, verbose: bool) -> bool:
    """Apply or update PEP 723 metadata to a script. Returns True if changed."""
    if not file_path.exists():
        if verbose:
            try:
                display = str(file_path.relative_to(PROJECT_ROOT))
            except ValueError:
                display = str(file_path)
            print(f"  SKIP (not found): {display}")
        return False

    content = file_path.read_text(encoding="utf-8")
    metadata_block = build_metadata_block(deps)

    try:
        display = str(file_path.relative_to(PROJECT_ROOT))
    except ValueError:
        display = str(file_path)

    # Check if metadata is already correct
    block = find_metadata_block(content)
    if block is not None:
        start_idx, end_idx = block
        lines = content.split("\n")
        existing_block = "\n".join(lines[start_idx : end_idx + 1]) + "\n"
        if existing_block.strip() == metadata_block.strip():
            if verbose:
                print(f"  OK (unchanged): {display}")
            return False

        # Different metadata — strip and re-apply
        content = strip_existing_metadata(content)

    # Determine insertion point: after shebang if present
    if content.startswith("#!"):
        first_newline = content.index("\n")
        shebang = content[: first_newline + 1]
        rest = content[first_newline + 1 :]
        new_content = shebang + metadata_block + rest
    else:
        new_content = metadata_block + content

    if check:
        print(f"  WOULD UPDATE: {display}")
        return True

    file_path.write_text(new_content, encoding="utf-8")
    print(f"  UPDATED: {display}")
    return True


def main():
    check = "--check" in sys.argv
    verbose = "--verbose" in sys.argv

    if check:
        print("DRY RUN — no files will be modified\n")

    print(f"Scanning skills in: {SKILLS_DIR.relative_to(PROJECT_ROOT)}")
    print()

    updated = 0
    skipped = 0
    missing = 0

    for (skill_name, script_name), deps in sorted(DEPENDENCY_MAP.items()):
        file_path = SKILLS_DIR / skill_name / "scripts" / script_name
        if not file_path.exists():
            if verbose:
                print(f"  MISSING: {skill_name}/scripts/{script_name}")
            missing += 1
            continue

        changed = apply_metadata(file_path, deps, check, verbose)
        if changed:
            updated += 1
        else:
            skipped += 1

    print()
    print(f"Results: {updated} updated, {skipped} already correct, {missing} missing")

    if check and updated > 0:
        print("\nRun without --check to apply changes.")
        sys.exit(1)

    sys.exit(0)


if __name__ == "__main__":
    main()
