#!/usr/bin/env python3
"""Tests for reapply-skill-deps.py"""

import sys
import tempfile
from pathlib import Path

# Import the module under test
sys.path.insert(0, str(Path(__file__).parent))
from importlib import import_module

mod = import_module("reapply-skill-deps")

build_metadata_block = mod.build_metadata_block
find_metadata_block = mod.find_metadata_block
has_metadata = mod.has_metadata
strip_existing_metadata = mod.strip_existing_metadata
apply_metadata = mod.apply_metadata


def test_build_metadata_block_single_dep():
    result = build_metadata_block(["pypdf"])
    assert result == '# /// script\n# dependencies = ["pypdf"]\n# ///\n'


def test_build_metadata_block_multiple_deps():
    result = build_metadata_block(["defusedxml", "Pillow"])
    assert result == '# /// script\n# dependencies = ["defusedxml", "Pillow"]\n# ///\n'


def test_find_metadata_block_present():
    content = '# /// script\n# dependencies = ["pypdf"]\n# ///\nimport sys\n'
    result = find_metadata_block(content)
    assert result == (0, 2)


def test_find_metadata_block_after_shebang():
    content = '#!/usr/bin/env python3\n# /// script\n# dependencies = ["pypdf"]\n# ///\nimport sys\n'
    result = find_metadata_block(content)
    assert result == (1, 3)


def test_find_metadata_block_not_present():
    content = 'import sys\nfrom pypdf import PdfReader\n'
    result = find_metadata_block(content)
    assert result is None


def test_find_metadata_block_unterminated():
    """Unterminated block (no # ///) should return None, not truncate."""
    content = '# /// script\n# dependencies = ["pypdf"]\nimport sys\nfrom pypdf import PdfReader\n'
    result = find_metadata_block(content)
    assert result is None


def test_find_metadata_block_marker_deep_in_file():
    """Marker appearing past line 20 should be ignored."""
    lines = ["import something"] * 25 + ["# /// script", '# dependencies = ["x"]', "# ///"]
    content = "\n".join(lines)
    result = find_metadata_block(content)
    assert result is None


def test_has_metadata_true():
    content = '# /// script\n# dependencies = ["pypdf"]\n# ///\nimport sys\n'
    assert has_metadata(content) is True


def test_has_metadata_false():
    content = 'import sys\nfrom pypdf import PdfReader\n'
    assert has_metadata(content) is False


def test_strip_existing_metadata():
    content = '# /// script\n# dependencies = ["pypdf"]\n# ///\nimport sys\n'
    result = strip_existing_metadata(content)
    assert result == "import sys\n"


def test_strip_existing_metadata_no_block():
    content = 'import sys\nfrom pypdf import PdfReader\n'
    result = strip_existing_metadata(content)
    assert result == content  # unchanged


def test_strip_existing_metadata_unterminated():
    """Unterminated block should NOT be stripped — content returned unchanged."""
    content = '# /// script\n# dependencies = ["pypdf"]\nimport sys\nfrom pypdf import PdfReader\n'
    result = strip_existing_metadata(content)
    assert result == content  # unchanged, no truncation


def test_apply_metadata_new_file():
    """Apply metadata to a file with no existing metadata."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
        f.write('import sys\nfrom pypdf import PdfReader\n')
        f.flush()
        path = Path(f.name)

    try:
        changed = apply_metadata(path, ["pypdf"], check=False, verbose=False)
        assert changed is True
        content = path.read_text()
        assert content.startswith("# /// script\n")
        assert '"pypdf"' in content
        assert "import sys" in content
    finally:
        path.unlink()


def test_apply_metadata_idempotent():
    """Running twice should not change the file the second time."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
        f.write('# /// script\n# dependencies = ["pypdf"]\n# ///\nimport sys\n')
        f.flush()
        path = Path(f.name)

    try:
        changed = apply_metadata(path, ["pypdf"], check=False, verbose=False)
        assert changed is False
    finally:
        path.unlink()


def test_apply_metadata_updates_stale():
    """If deps changed, metadata should be updated."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
        f.write('# /// script\n# dependencies = ["old-package"]\n# ///\nimport sys\n')
        f.flush()
        path = Path(f.name)

    try:
        changed = apply_metadata(path, ["new-package"], check=False, verbose=False)
        assert changed is True
        content = path.read_text()
        assert '"new-package"' in content
        assert '"old-package"' not in content
    finally:
        path.unlink()


def test_apply_metadata_preserves_shebang():
    """Shebang line should remain at the top."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
        f.write('#!/usr/bin/env python3\nimport sys\n')
        f.flush()
        path = Path(f.name)

    try:
        changed = apply_metadata(path, ["pypdf"], check=False, verbose=False)
        assert changed is True
        content = path.read_text()
        assert content.startswith("#!/usr/bin/env python3\n# /// script\n")
    finally:
        path.unlink()


def test_apply_metadata_check_mode():
    """Check mode should not modify the file."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
        original = 'import sys\nfrom pypdf import PdfReader\n'
        f.write(original)
        f.flush()
        path = Path(f.name)

    try:
        changed = apply_metadata(path, ["pypdf"], check=True, verbose=False)
        assert changed is True
        # File should be unchanged
        assert path.read_text() == original
    finally:
        path.unlink()


def test_apply_metadata_missing_file():
    """Missing file should return False."""
    path = Path("/nonexistent/path/script.py")
    changed = apply_metadata(path, ["pypdf"], check=False, verbose=False)
    assert changed is False


if __name__ == "__main__":
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    passed = 0
    failed = 0
    for test in tests:
        try:
            test()
            passed += 1
            print(f"  ✓ {test.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"  ✗ {test.__name__}: {e}")
        except Exception as e:
            failed += 1
            print(f"  ✗ {test.__name__}: {type(e).__name__}: {e}")

    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)
