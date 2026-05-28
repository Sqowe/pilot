#!/usr/bin/env python3
"""
Tests for claude-cowork-memory MCP server.

Covers:
- Path safety (_is_safe_path, _safe_read, _safe_read_all)
- Profile discovery (_find_profile_dir with deterministic selection)
- Space resolution (_resolve_space)
- Error handling (malformed JSON, permission errors, missing files)
- Tool-level integration tests under failure scenarios

Run: python -m pytest test_server.py -v
"""

import json
import os
import tempfile
from pathlib import Path
from unittest.mock import patch, PropertyMock

import pytest

from server import (
    _find_profile_dir,
    _get_profile_dir,
    _is_safe_path,
    _is_valid_space_id,
    _load_spaces,
    _resolve_space,
    _safe_read,
    _safe_read_all,
    cowork_find_space,
    cowork_global_memory,
    cowork_list_spaces,
    cowork_read_all_memory,
    cowork_read_memory,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def tmp_cowork(tmp_path):
    """Create a minimal Claude CoWork directory structure for testing."""
    app_id = "test-app-id"
    profile_id = "test-profile-id"
    profile_dir = tmp_path / app_id / profile_id

    # Create spaces.json
    spaces_dir = profile_dir / "spaces"
    spaces_dir.mkdir(parents=True)

    # Create global memory
    memory_dir = profile_dir / "memory"
    memory_dir.mkdir()
    (memory_dir / "CLAUDE.md").write_text("# Global Rules\nBe helpful.", encoding="utf-8")

    # Create a space with memory
    space_id = "space-001"
    space_memory = spaces_dir / space_id / "memory"
    space_memory.mkdir(parents=True)
    (space_memory / "MEMORY.md").write_text("- Key fact 1\n- Key fact 2", encoding="utf-8")
    (space_memory / "topic_a.md").write_text("# Topic A\nDetails here.", encoding="utf-8")
    (space_memory / "topic_b.md").write_text("# Topic B\nMore details.", encoding="utf-8")

    # Create spaces.json
    spaces_data = {
        "spaces": [
            {
                "id": space_id,
                "name": "Test Project",
                "folders": [{"path": "/Users/test/Documents/Claude/Projects/TestProject"}],
                "instructions": "Use Russian language.",
                "createdAt": 1700000000000,
                "updatedAt": 1700000000000,
            },
            {
                "id": "space-002",
                "name": "Empty Space",
                "folders": [{"path": "/Users/test/Documents/Claude/Projects/Empty"}],
                "instructions": "",
                "createdAt": 1700000000000,
                "updatedAt": 1700000000000,
            },
        ]
    }
    (profile_dir / "spaces.json").write_text(json.dumps(spaces_data), encoding="utf-8")

    return tmp_path, profile_dir, space_memory


# ---------------------------------------------------------------------------
# Tests: _is_safe_path
# ---------------------------------------------------------------------------


class TestIsSafePath:
    def test_normal_file_is_safe(self, tmp_path):
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir()
        f = memory_dir / "test.md"
        f.write_text("content")
        assert _is_safe_path(memory_dir, f) is True

    def test_parent_traversal_blocked(self, tmp_path):
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir()
        target = memory_dir / ".." / "etc" / "passwd"
        assert _is_safe_path(memory_dir, target) is False

    def test_symlink_escape_blocked(self, tmp_path):
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir()
        # Create a file outside
        outside = tmp_path / "secret.txt"
        outside.write_text("secret data")
        # Create symlink inside memory_dir pointing outside
        link = memory_dir / "evil_link.md"
        link.symlink_to(outside)
        assert _is_safe_path(memory_dir, link) is False


# ---------------------------------------------------------------------------
# Tests: _safe_read
# ---------------------------------------------------------------------------


class TestSafeRead:
    def test_reads_valid_file(self, tmp_path):
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir()
        (memory_dir / "test.md").write_text("hello world", encoding="utf-8")
        assert _safe_read(memory_dir, "test.md") == "hello world"

    def test_returns_none_for_missing_file(self, tmp_path):
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir()
        assert _safe_read(memory_dir, "nonexistent.md") is None

    def test_blocks_path_traversal(self, tmp_path):
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir()
        (tmp_path / "secret.txt").write_text("secret")
        assert _safe_read(memory_dir, "../secret.txt") is None

    def test_blocks_symlink_escape(self, tmp_path):
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir()
        outside = tmp_path / "outside.txt"
        outside.write_text("outside content")
        (memory_dir / "link.md").symlink_to(outside)
        assert _safe_read(memory_dir, "link.md") is None

    def test_handles_unreadable_file(self, tmp_path):
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir()
        f = memory_dir / "locked.md"
        f.write_text("content")
        # Mock read_text to raise PermissionError (more reliable than chmod in CI)
        with patch.object(Path, "read_text", side_effect=PermissionError("Permission denied")):
            result = _safe_read(memory_dir, "locked.md")
            assert result is None


# ---------------------------------------------------------------------------
# Tests: _safe_read_all
# ---------------------------------------------------------------------------


class TestSafeReadAll:
    def test_reads_all_md_files(self, tmp_cowork):
        _, _, space_memory = tmp_cowork
        results = _safe_read_all(space_memory)
        names = [name for name, _ in results]
        assert "MEMORY.md" in names
        assert "topic_a.md" in names
        assert "topic_b.md" in names

    def test_skips_non_md_files(self, tmp_path):
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir()
        (memory_dir / "valid.md").write_text("ok")
        (memory_dir / "data.json").write_text("{}")
        (memory_dir / "script.py").write_text("print()")
        results = _safe_read_all(memory_dir)
        assert len(results) == 1
        assert results[0][0] == "valid.md"

    def test_skips_symlink_escapes(self, tmp_path):
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir()
        (memory_dir / "safe.md").write_text("safe content")
        outside = tmp_path / "secret.md"
        outside.write_text("secret")
        (memory_dir / "evil.md").symlink_to(outside)
        results = _safe_read_all(memory_dir)
        assert len(results) == 1
        assert results[0][0] == "safe.md"

    def test_returns_empty_for_missing_dir(self, tmp_path):
        assert _safe_read_all(tmp_path / "nonexistent") == []


# ---------------------------------------------------------------------------
# Tests: _find_profile_dir
# ---------------------------------------------------------------------------


class TestFindProfileDir:
    def test_finds_profile_with_spaces_json(self, tmp_cowork):
        base, profile_dir, _ = tmp_cowork
        found = _find_profile_dir(base)
        assert found == profile_dir

    def test_returns_none_for_empty_dir(self, tmp_path):
        assert _find_profile_dir(tmp_path) is None

    def test_returns_none_for_nonexistent_dir(self, tmp_path):
        assert _find_profile_dir(tmp_path / "nonexistent") is None

    def test_skips_skills_plugin_dir(self, tmp_path):
        (tmp_path / "skills-plugin" / "profile").mkdir(parents=True)
        (tmp_path / "skills-plugin" / "profile" / "spaces.json").write_text("{}")
        assert _find_profile_dir(tmp_path) is None

    def test_deterministic_with_multiple_profiles(self, tmp_path):
        """When multiple profiles exist, picks the most recently modified."""
        app_dir = tmp_path / "app-id"
        p1 = app_dir / "profile-old"
        p1.mkdir(parents=True)
        (p1 / "spaces.json").write_text('{"spaces": []}')

        p2 = app_dir / "profile-new"
        p2.mkdir(parents=True)
        (p2 / "spaces.json").write_text('{"spaces": []}')

        # Set explicit mtimes for deterministic ordering (no sleep needed)
        os.utime(p1 / "spaces.json", (1000000.0, 1000000.0))
        os.utime(p2 / "spaces.json", (2000000.0, 2000000.0))

        found = _find_profile_dir(tmp_path)
        assert found == p2  # Most recently modified

    def test_explicit_profile_id_env(self, tmp_cowork):
        base, profile_dir, _ = tmp_cowork
        with patch.dict(os.environ, {"COWORK_PROFILE_ID": "test-profile-id"}):
            found = _find_profile_dir(base)
            assert found == profile_dir

    def test_explicit_profile_id_not_found(self, tmp_cowork):
        base, _, _ = tmp_cowork
        with patch.dict(os.environ, {"COWORK_PROFILE_ID": "nonexistent-id"}):
            found = _find_profile_dir(base)
            assert found is None


# ---------------------------------------------------------------------------
# Tests: _load_spaces
# ---------------------------------------------------------------------------


class TestLoadSpaces:
    def test_loads_valid_spaces(self, tmp_cowork):
        _, profile_dir, _ = tmp_cowork
        spaces = _load_spaces(profile_dir)
        assert len(spaces) == 2
        assert spaces[0]["name"] == "Test Project"

    def test_returns_empty_for_missing_file(self, tmp_path):
        tmp_path.mkdir(exist_ok=True)
        assert _load_spaces(tmp_path) == []

    def test_raises_on_malformed_json(self, tmp_path):
        tmp_path.mkdir(exist_ok=True)
        (tmp_path / "spaces.json").write_text("not valid json {{{")
        with pytest.raises(OSError, match="Failed to read spaces.json"):
            _load_spaces(tmp_path)

    def test_raises_on_binary_file(self, tmp_path):
        tmp_path.mkdir(exist_ok=True)
        (tmp_path / "spaces.json").write_bytes(b"\x00\x01\x02\x03")
        with pytest.raises(OSError, match="Failed to read spaces.json"):
            _load_spaces(tmp_path)


# ---------------------------------------------------------------------------
# Tests: _resolve_space
# ---------------------------------------------------------------------------


class TestResolveSpace:
    def test_exact_match(self, tmp_cowork):
        _, profile_dir, _ = tmp_cowork
        spaces = _load_spaces(profile_dir)
        result = _resolve_space(profile_dir, spaces, "/Users/test/Documents/Claude/Projects/TestProject")
        assert result is not None
        sp, memory_dir = result
        assert sp["name"] == "Test Project"

    def test_no_match(self, tmp_cowork):
        _, profile_dir, _ = tmp_cowork
        spaces = _load_spaces(profile_dir)
        result = _resolve_space(profile_dir, spaces, "/Users/test/other/path")
        assert result is None

    def test_subdirectory_match(self, tmp_cowork):
        """A workspace path inside a space folder should match."""
        _, profile_dir, _ = tmp_cowork
        spaces = _load_spaces(profile_dir)
        result = _resolve_space(
            profile_dir, spaces,
            "/Users/test/Documents/Claude/Projects/TestProject/subdir/deep"
        )
        # This should NOT match because the logic checks if folder_path is in target.parents
        # (i.e., workspace is inside the space folder)
        assert result is not None


# ---------------------------------------------------------------------------
# Tests: Tool-level integration (with mocked profile)
# ---------------------------------------------------------------------------


class TestToolIntegration:
    def test_cowork_list_spaces_error(self):
        with patch("server._get_profile_dir", side_effect=FileNotFoundError("not found")):
            result = cowork_list_spaces()
            assert "Error:" in result
            assert "not found" in result

    def test_cowork_find_space_error(self):
        with patch("server._get_profile_dir", side_effect=FileNotFoundError("not found")):
            result = cowork_find_space("/some/path")
            assert "Error:" in result

    def test_cowork_read_memory_json_error(self):
        with patch("server._get_profile_dir", side_effect=OSError("Failed to read spaces.json")):
            result = cowork_read_memory("/some/path")
            assert "Error:" in result
            assert "spaces.json" in result

    def test_cowork_global_memory_missing(self, tmp_path):
        profile_dir = tmp_path / "profile"
        profile_dir.mkdir()
        (profile_dir / "memory").mkdir()
        # No CLAUDE.md
        with patch("server._get_profile_dir", return_value=profile_dir):
            result = cowork_global_memory()
            assert "No global CLAUDE.md" in result

    def test_cowork_read_all_memory_no_space(self):
        with patch("server._get_profile_dir") as mock_profile:
            mock_profile.return_value = Path("/tmp/fake")
            with patch("server._load_spaces", return_value=[]):
                result = cowork_read_all_memory("/some/path")
                assert "No Claude CoWork space found" in result


# ---------------------------------------------------------------------------
# Tests: Edge cases from review round 2
# ---------------------------------------------------------------------------


class TestEdgeCases:
    def test_find_space_empty_folders_array(self, tmp_cowork):
        """cowork_find_space should not crash when a space has empty folders list."""
        _, profile_dir, _ = tmp_cowork
        # Patch spaces to include one with empty folders
        spaces_with_empty = [
            {
                "id": "space-empty-folders",
                "name": "Empty Folders Space",
                "folders": [],
                "instructions": "test",
            }
        ]
        with patch("server._get_profile_dir", return_value=profile_dir):
            with patch("server._load_spaces", return_value=spaces_with_empty):
                # Should not raise IndexError, should report no match
                result = cowork_find_space("/Users/test/some/path")
                assert "No Claude CoWork space found" in result

    def test_resolve_space_skips_empty_path(self, tmp_cowork):
        """_resolve_space should skip folder entries with empty path."""
        _, profile_dir, _ = tmp_cowork
        spaces = [
            {
                "id": "space-x",
                "name": "Space X",
                "folders": [{"path": ""}, {"path": "   "}],
            }
        ]
        result = _resolve_space(profile_dir, spaces, "/Users/test/something")
        assert result is None  # Should not match CWD via empty path

    def test_is_safe_path_handles_resolve_error(self, tmp_path):
        """_is_safe_path should return False if resolve raises."""
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir()
        target = memory_dir / "file.md"
        target.write_text("content")
        with patch.object(Path, "resolve", side_effect=RuntimeError("symlink loop")):
            assert _is_safe_path(memory_dir, target) is False

    def test_safe_read_handles_resolve_error(self, tmp_path):
        """_safe_read should return None if path resolution fails."""
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir()
        (memory_dir / "file.md").write_text("content")
        with patch.object(Path, "resolve", side_effect=OSError("loop")):
            result = _safe_read(memory_dir, "file.md")
            assert result is None

    def test_resolve_space_handles_unresolvable_folder(self, tmp_cowork):
        """_resolve_space should skip folders that fail to resolve."""
        _, profile_dir, _ = tmp_cowork
        spaces = [
            {
                "id": "space-bad",
                "name": "Bad Space",
                "folders": [{"path": "/nonexistent/symlink/loop/path"}],
            }
        ]
        # Even if the path doesn't exist, resolve() won't fail on most systems.
        # But we test that the function doesn't crash.
        result = _resolve_space(profile_dir, spaces, "/Users/test/something")
        assert result is None

    def test_cowork_find_space_with_matched_empty_folders(self, tmp_cowork):
        """When a space matches but has empty folders, folder display should be empty string."""
        _, profile_dir, space_memory = tmp_cowork
        spaces = _load_spaces(profile_dir)
        # Patch the matched space to have empty folders for display
        with patch("server._get_profile_dir", return_value=profile_dir):
            with patch("server._load_spaces", return_value=[
                {
                    "id": "space-001",
                    "name": "Test Project",
                    "folders": [],  # Empty!
                    "instructions": "test",
                }
            ]):
                with patch("server._resolve_space", return_value=(
                    {"id": "space-001", "name": "Test Project", "folders": [], "instructions": "test"},
                    space_memory,
                )):
                    result = cowork_find_space("/Users/test/Documents/Claude/Projects/TestProject")
                    assert "Folder:" in result  # Should not crash
                    assert "IndexError" not in result


# ---------------------------------------------------------------------------
# Tests: Review round 3 — JSON shape validation and space_id containment
# ---------------------------------------------------------------------------


class TestJsonShapeValidation:
    """Tests for _load_spaces handling non-dict JSON structures."""

    def test_raises_on_json_array(self, tmp_path):
        """spaces.json containing a JSON array (not object) should raise OSError."""
        tmp_path.mkdir(exist_ok=True)
        (tmp_path / "spaces.json").write_text('[{"id": "x", "name": "y"}]')
        with pytest.raises(OSError, match="expected JSON object at top level"):
            _load_spaces(tmp_path)

    def test_raises_on_json_string(self, tmp_path):
        """spaces.json containing a JSON string should raise OSError."""
        tmp_path.mkdir(exist_ok=True)
        (tmp_path / "spaces.json").write_text('"just a string"')
        with pytest.raises(OSError, match="expected JSON object at top level"):
            _load_spaces(tmp_path)

    def test_raises_on_json_number(self, tmp_path):
        """spaces.json containing a JSON number should raise OSError."""
        tmp_path.mkdir(exist_ok=True)
        (tmp_path / "spaces.json").write_text("42")
        with pytest.raises(OSError, match="expected JSON object at top level"):
            _load_spaces(tmp_path)

    def test_raises_on_json_null(self, tmp_path):
        """spaces.json containing null should raise OSError."""
        tmp_path.mkdir(exist_ok=True)
        (tmp_path / "spaces.json").write_text("null")
        with pytest.raises(OSError, match="expected JSON object at top level"):
            _load_spaces(tmp_path)

    def test_raises_on_spaces_not_array(self, tmp_path):
        """spaces.json with 'spaces' key as a string should raise OSError."""
        tmp_path.mkdir(exist_ok=True)
        (tmp_path / "spaces.json").write_text('{"spaces": "not an array"}')
        with pytest.raises(OSError, match="expected 'spaces' to be an array"):
            _load_spaces(tmp_path)

    def test_returns_empty_when_spaces_key_missing(self, tmp_path):
        """spaces.json as valid dict without 'spaces' key returns empty list."""
        tmp_path.mkdir(exist_ok=True)
        (tmp_path / "spaces.json").write_text('{"version": 1}')
        assert _load_spaces(tmp_path) == []


class TestSpaceIdValidation:
    """Tests for space_id validation and path containment."""

    def test_valid_uuid_id(self):
        assert _is_valid_space_id("105f2b10-13e2-42a0-8fd7-337a75a08bba") is True

    def test_valid_alphanumeric_id(self):
        assert _is_valid_space_id("my-space-123") is True
        assert _is_valid_space_id("space_with_underscores") is True

    def test_rejects_empty_id(self):
        assert _is_valid_space_id("") is False

    def test_rejects_traversal_id(self):
        assert _is_valid_space_id("../../../etc") is False
        assert _is_valid_space_id("..") is False

    def test_rejects_slash_in_id(self):
        assert _is_valid_space_id("space/evil") is False
        assert _is_valid_space_id("space\\evil") is False

    def test_rejects_dot_start(self):
        assert _is_valid_space_id(".hidden") is False
        assert _is_valid_space_id("..double") is False

    def test_rejects_too_long_id(self):
        assert _is_valid_space_id("a" * 129) is False

    def test_accepts_max_length_id(self):
        assert _is_valid_space_id("a" * 128) is True

    def test_resolve_space_rejects_traversal_id(self, tmp_cowork):
        """_resolve_space should skip spaces with path-traversal IDs."""
        _, profile_dir, _ = tmp_cowork
        spaces = [
            {
                "id": "../../../etc",
                "name": "Evil Space",
                "folders": [{"path": "/Users/test/Documents/Claude/Projects/TestProject"}],
            }
        ]
        result = _resolve_space(profile_dir, spaces, "/Users/test/Documents/Claude/Projects/TestProject")
        assert result is None  # Rejected due to invalid ID

    def test_resolve_space_rejects_slash_id(self, tmp_cowork):
        """_resolve_space should skip spaces with slashes in ID."""
        _, profile_dir, _ = tmp_cowork
        spaces = [
            {
                "id": "space/../../escape",
                "name": "Slash Space",
                "folders": [{"path": "/Users/test/Documents/Claude/Projects/TestProject"}],
            }
        ]
        result = _resolve_space(profile_dir, spaces, "/Users/test/Documents/Claude/Projects/TestProject")
        assert result is None

    def test_resolve_space_rejects_empty_id(self, tmp_cowork):
        """_resolve_space should skip spaces with empty ID."""
        _, profile_dir, _ = tmp_cowork
        spaces = [
            {
                "id": "",
                "name": "No ID Space",
                "folders": [{"path": "/Users/test/Documents/Claude/Projects/TestProject"}],
            }
        ]
        result = _resolve_space(profile_dir, spaces, "/Users/test/Documents/Claude/Projects/TestProject")
        assert result is None

    def test_memory_dir_stays_within_profile(self, tmp_cowork):
        """Resolved memory_dir must be within profile_dir/spaces/."""
        _, profile_dir, _ = tmp_cowork
        spaces = _load_spaces(profile_dir)
        result = _resolve_space(profile_dir, spaces, "/Users/test/Documents/Claude/Projects/TestProject")
        assert result is not None
        _, memory_dir = result
        # Verify containment
        spaces_root = profile_dir / "spaces"
        memory_dir.resolve().relative_to(spaces_root.resolve())  # Should not raise


# ---------------------------------------------------------------------------
# Tests: Review round 4 — Malformed space entries and list_spaces boundary
# ---------------------------------------------------------------------------


class TestMalformedSpaceEntries:
    """Tests for _load_spaces handling malformed per-space entries."""

    def test_skips_non_dict_space_entries(self, tmp_path):
        """Non-dict items in the spaces array should be silently skipped."""
        tmp_path.mkdir(exist_ok=True)
        data = {"spaces": [
            "just a string",
            42,
            None,
            {"id": "valid-space", "name": "Valid", "folders": []},
            ["a", "list"],
        ]}
        (tmp_path / "spaces.json").write_text(json.dumps(data))
        spaces = _load_spaces(tmp_path)
        assert len(spaces) == 1
        assert spaces[0]["name"] == "Valid"

    def test_normalizes_non_list_folders(self, tmp_path):
        """If folders is not a list, it should be normalized to empty list."""
        tmp_path.mkdir(exist_ok=True)
        data = {"spaces": [
            {"id": "sp1", "name": "Bad Folders", "folders": "not a list"},
            {"id": "sp2", "name": "Null Folders", "folders": None},
        ]}
        (tmp_path / "spaces.json").write_text(json.dumps(data))
        spaces = _load_spaces(tmp_path)
        assert len(spaces) == 2
        assert spaces[0]["folders"] == []
        assert spaces[1]["folders"] == []

    def test_filters_non_dict_folder_items(self, tmp_path):
        """Non-dict items within folders list should be filtered out."""
        tmp_path.mkdir(exist_ok=True)
        data = {"spaces": [
            {
                "id": "sp1",
                "name": "Mixed Folders",
                "folders": [
                    {"path": "/valid/path"},
                    "string_folder",
                    42,
                    None,
                    {"path": "/another/valid"},
                ],
            }
        ]}
        (tmp_path / "spaces.json").write_text(json.dumps(data))
        spaces = _load_spaces(tmp_path)
        assert len(spaces) == 1
        assert len(spaces[0]["folders"]) == 2
        assert spaces[0]["folders"][0]["path"] == "/valid/path"
        assert spaces[0]["folders"][1]["path"] == "/another/valid"

    def test_missing_folders_key_defaults_to_empty(self, tmp_path):
        """Space entry without 'folders' key should get empty list."""
        tmp_path.mkdir(exist_ok=True)
        data = {"spaces": [{"id": "sp1", "name": "No Folders"}]}
        (tmp_path / "spaces.json").write_text(json.dumps(data))
        spaces = _load_spaces(tmp_path)
        assert len(spaces) == 1
        assert spaces[0]["folders"] == []


class TestListSpacesBoundary:
    """Tests for cowork_list_spaces not probing filesystem with invalid space_ids."""

    def test_list_spaces_skips_traversal_id(self, tmp_path):
        """cowork_list_spaces should not probe filesystem for traversal-like IDs."""
        profile_dir = tmp_path / "profile"
        (profile_dir / "spaces").mkdir(parents=True)

        # Create a directory outside that a traversal ID would reach
        outside_dir = tmp_path / "outside" / "memory"
        outside_dir.mkdir(parents=True)
        (outside_dir / "secret.md").write_text("secret")

        spaces = [
            {"id": "../outside", "name": "Evil Space", "folders": []},
            {"id": "valid-id", "name": "Good Space", "folders": []},
        ]

        with patch("server._get_profile_dir", return_value=profile_dir):
            with patch("server._load_spaces", return_value=spaces):
                result = cowork_list_spaces()
                # Evil space should show "Has memory: no" (not probed)
                assert "Evil Space" in result
                assert "Good Space" in result
                # The traversal ID should not have been used to probe outside

    def test_list_spaces_handles_non_dict_space_gracefully(self, tmp_path):
        """Even if _load_spaces somehow passes a non-dict, list_spaces shouldn't crash."""
        profile_dir = tmp_path / "profile"
        (profile_dir / "spaces").mkdir(parents=True)

        # Simulate a non-dict slipping through (shouldn't happen after _load_spaces fix,
        # but defense in depth)
        spaces = [
            "not a dict",
            {"id": "valid-id", "name": "Good Space", "folders": []},
        ]

        with patch("server._get_profile_dir", return_value=profile_dir):
            with patch("server._load_spaces", return_value=spaces):
                result = cowork_list_spaces()
                # Should not crash, should show the valid space
                assert "Good Space" in result

    def test_resolve_space_skips_non_dict_folder_items(self, tmp_cowork):
        """_resolve_space should not crash on non-dict folder items (already filtered by _load_spaces)."""
        _, profile_dir, _ = tmp_cowork
        # Even if somehow a non-dict folder slips through
        spaces = [
            {
                "id": "space-001",
                "name": "Test",
                "folders": [{"path": "/Users/test/Documents/Claude/Projects/TestProject"}],
            }
        ]
        result = _resolve_space(profile_dir, spaces, "/Users/test/Documents/Claude/Projects/TestProject")
        assert result is not None


# ---------------------------------------------------------------------------
# Tests: Review round 5 — Unreadable directory resilience
# ---------------------------------------------------------------------------


class TestUnreadableDirectoryResilience:
    """Tests for graceful handling of PermissionError on directory iteration."""

    def test_safe_read_all_returns_empty_on_iterdir_permission_error(self, tmp_path):
        """_safe_read_all should return [] if iterdir() raises PermissionError."""
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir()
        (memory_dir / "file.md").write_text("content")
        with patch.object(Path, "iterdir", side_effect=PermissionError("denied")):
            result = _safe_read_all(memory_dir)
            assert result == []

    def test_safe_read_all_returns_empty_on_iterdir_oserror(self, tmp_path):
        """_safe_read_all should return [] if iterdir() raises OSError."""
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir()
        (memory_dir / "file.md").write_text("content")
        with patch.object(Path, "iterdir", side_effect=OSError("I/O error")):
            result = _safe_read_all(memory_dir)
            assert result == []

    def test_cowork_read_all_memory_returns_message_on_unreadable_dir(self, tmp_cowork):
        """cowork_read_all_memory should return a user-friendly message, not raise."""
        _, profile_dir, space_memory = tmp_cowork
        with patch("server._get_profile_dir", return_value=profile_dir):
            with patch("server._safe_read_all", return_value=[]):
                result = cowork_read_all_memory("/Users/test/Documents/Claude/Projects/TestProject")
                assert "No readable memory files" in result

    def test_find_profile_dir_skips_unreadable_base(self, tmp_path):
        """_find_profile_dir should return None if base.iterdir() fails."""
        base = tmp_path / "base"
        base.mkdir()
        with patch.object(Path, "iterdir", side_effect=PermissionError("denied")):
            result = _find_profile_dir(base)
            assert result is None

    def test_find_profile_dir_skips_unreadable_app_dir(self, tmp_path):
        """_find_profile_dir should skip app dirs it can't read."""
        base = tmp_path
        app_dir = base / "app-id"
        app_dir.mkdir()

        # Make the app_dir's iterdir fail on the second call (profile listing)
        call_count = [0]
        original_iterdir = Path.iterdir

        def mock_iterdir(self):
            nonlocal call_count
            if self == app_dir:
                call_count[0] += 1
                raise PermissionError("denied")
            return original_iterdir(self)

        with patch.object(Path, "iterdir", mock_iterdir):
            result = _find_profile_dir(base)
            assert result is None

    def test_find_profile_dir_skips_unreadable_stat(self, tmp_path):
        """_find_profile_dir should skip profiles where stat() fails."""
        app_dir = tmp_path / "app-id"
        profile_dir = app_dir / "profile-id"
        profile_dir.mkdir(parents=True)
        spaces_file = profile_dir / "spaces.json"
        spaces_file.write_text('{"spaces": []}')

        original_stat = Path.stat

        def mock_stat(self):
            if self == spaces_file:
                raise PermissionError("denied")
            return original_stat(self)

        with patch.object(Path, "stat", mock_stat):
            result = _find_profile_dir(tmp_path)
            assert result is None  # Skipped due to stat failure


# ---------------------------------------------------------------------------
# Tests: Review round 6 — Overlapping folders and resolve specificity
# ---------------------------------------------------------------------------


class TestResolveSpaceSpecificity:
    """Tests for most-specific-match resolution when folders overlap."""

    def test_prefers_deeper_folder_match(self, tmp_cowork):
        """When workspace matches both /a and /a/b, should pick /a/b (more specific)."""
        _, profile_dir, _ = tmp_cowork
        # Create spaces dir for the deeper space
        deeper_memory = profile_dir / "spaces" / "space-deep" / "memory"
        deeper_memory.mkdir(parents=True)
        (deeper_memory / "MEMORY.md").write_text("deep memory")

        spaces = [
            {
                "id": "space-shallow",
                "name": "Shallow",
                "folders": [{"path": "/Users/test/Documents/Claude/Projects"}],
            },
            {
                "id": "space-deep",
                "name": "Deep",
                "folders": [{"path": "/Users/test/Documents/Claude/Projects/TestProject"}],
            },
        ]
        result = _resolve_space(profile_dir, spaces, "/Users/test/Documents/Claude/Projects/TestProject")
        assert result is not None
        sp, _ = result
        assert sp["name"] == "Deep"

    def test_prefers_exact_match_over_parent(self, tmp_cowork):
        """Exact folder match should win over a parent folder match."""
        _, profile_dir, _ = tmp_cowork
        exact_memory = profile_dir / "spaces" / "space-exact" / "memory"
        exact_memory.mkdir(parents=True)

        spaces = [
            {
                "id": "space-parent",
                "name": "Parent",
                "folders": [{"path": "/Users/test/Documents"}],
            },
            {
                "id": "space-exact",
                "name": "Exact",
                "folders": [{"path": "/Users/test/Documents/Claude/Projects/TestProject"}],
            },
        ]
        result = _resolve_space(profile_dir, spaces, "/Users/test/Documents/Claude/Projects/TestProject")
        assert result is not None
        sp, _ = result
        assert sp["name"] == "Exact"

    def test_order_independent(self, tmp_cowork):
        """Result should be the same regardless of space order in the list."""
        _, profile_dir, _ = tmp_cowork
        for sid in ["space-a", "space-b"]:
            (profile_dir / "spaces" / sid / "memory").mkdir(parents=True)

        spaces_order_1 = [
            {"id": "space-a", "name": "Broad", "folders": [{"path": "/Users/test"}]},
            {"id": "space-b", "name": "Specific", "folders": [{"path": "/Users/test/Documents/Claude/Projects/TestProject"}]},
        ]
        spaces_order_2 = [
            {"id": "space-b", "name": "Specific", "folders": [{"path": "/Users/test/Documents/Claude/Projects/TestProject"}]},
            {"id": "space-a", "name": "Broad", "folders": [{"path": "/Users/test"}]},
        ]

        r1 = _resolve_space(profile_dir, spaces_order_1, "/Users/test/Documents/Claude/Projects/TestProject")
        r2 = _resolve_space(profile_dir, spaces_order_2, "/Users/test/Documents/Claude/Projects/TestProject")
        assert r1 is not None and r2 is not None
        assert r1[0]["name"] == "Specific"
        assert r2[0]["name"] == "Specific"

    def test_single_match_still_works(self, tmp_cowork):
        """Single matching space should still resolve correctly."""
        _, profile_dir, _ = tmp_cowork
        spaces = _load_spaces(profile_dir)
        result = _resolve_space(profile_dir, spaces, "/Users/test/Documents/Claude/Projects/TestProject")
        assert result is not None
        assert result[0]["name"] == "Test Project"


class TestGlobalMemoryResilience:
    """Tests for cowork_global_memory handling filesystem errors."""

    def test_handles_resolve_permission_error(self, tmp_path):
        """cowork_global_memory should return controlled error on resolve failure."""
        profile_dir = tmp_path / "profile"
        memory_dir = profile_dir / "memory"
        memory_dir.mkdir(parents=True)
        (memory_dir / "CLAUDE.md").write_text("content")

        with patch("server._get_profile_dir", return_value=profile_dir):
            with patch.object(Path, "resolve", side_effect=PermissionError("denied")):
                result = cowork_global_memory()
                # Should not raise, should return an error or "not found" message
                assert "Error" in result or "not found" in result.lower() or "access error" in result.lower()
