# Builtin Skills: Dependency Maintenance

## Context

The builtin skills in `resources/skills/` originate from Anthropic's Claude skills
repository. We maintain local modifications that add **PEP 723 inline dependency
metadata** to Python scripts, enabling `uv run` to automatically resolve packages
without manual `pip install` or a sandbox environment.

When skills are updated from upstream (Anthropic's repo), these modifications get
overwritten. This document describes how to restore them.

## Rule: After Any Upstream Skill Sync

**Whenever builtin skills in `resources/skills/` are updated from an upstream source
(Anthropic Claude skills repo, pi-coding-agent SDK, or manual copy), you MUST
re-apply PEP 723 inline dependency metadata to all Python scripts that import
third-party packages.**

### How to re-apply

Run the maintenance script:

```bash
python3 scripts/reapply-skill-deps.py
```

This script:

- Scans all Python scripts in `resources/skills/*/scripts/`
- Detects third-party imports that require PEP 723 metadata
- Adds or updates the `# /// script` block at the top of each file
- Reports what was changed

### Manual verification

After running the script, verify with:

```bash
uv run resources/skills/pdf/scripts/check_fillable_fields.py 2>&1 | head -3
uv run resources/skills/skill-creator/scripts/quick_validate.py resources/skills/pdf
```

If `uv` installs packages and the scripts execute (even with "missing argument" errors),
the metadata is correct.

## Dependency Map

These are the known third-party dependencies per script. If upstream adds new scripts
with new imports, add them to this map and to `scripts/reapply-skill-deps.py`.

| Skill         | Script                              | Dependencies           |
| ------------- | ----------------------------------- | ---------------------- |
| pdf           | `check_fillable_fields.py`          | `pypdf`                |
| pdf           | `convert_pdf_to_images.py`          | `pdf2image`            |
| pdf           | `create_validation_image.py`        | `Pillow`               |
| pdf           | `extract_form_field_info.py`        | `pypdf`                |
| pdf           | `extract_form_structure.py`         | `pdfplumber`           |
| pdf           | `fill_fillable_fields.py`           | `pypdf`                |
| pdf           | `fill_pdf_form_with_annotations.py` | `pypdf`                |
| pptx          | `clean.py`                          | `defusedxml`           |
| pptx          | `thumbnail.py`                      | `defusedxml`, `Pillow` |
| xlsx          | `recalc.py`                         | `openpyxl`             |
| docx          | `comment.py`                        | `defusedxml`           |
| skill-creator | `quick_validate.py`                 | `pyyaml`               |

Scripts NOT in this table use only the Python standard library and need no metadata.

## SKILL.md Updates

Each skill's SKILL.md must contain a note instructing the agent to use `uv run scripts/...`
instead of `python3 scripts/...`. After upstream sync, check that this instruction
is present near the top of each SKILL.md. If missing, add:

````markdown
**Important: Running skill scripts.** Python scripts in `scripts/` use PEP 723
inline dependency metadata. Run them with `uv run` to automatically manage
dependencies:

\```bash
uv run scripts/<script_name>.py <args>
\```

Do NOT use bare `python3 scripts/...` — dependencies will be missing.
Always use `uv run scripts/...`.
````

## When NOT to Apply

- If the project migrates to a sandbox-based execution model (Docker/Lima) where
  packages are pre-installed in the container image, this metadata becomes optional
  (but is still harmless and good practice).
- If upstream eventually adopts PEP 723 metadata natively, this maintenance becomes
  unnecessary. Check upstream scripts before re-applying.

## agent-runner.ts System Prompt

The file `src/main/claude/agent-runner.ts` contains a `<bundled_executables>` hint
in the system prompt that instructs the agent to use `uv run` for PEP 723 scripts.
If this hint is ever removed or overwritten, restore the line:

```
- For Python scripts with PEP 723 inline dependency metadata (# /// script), always use `uv run script.py` instead of `python3 script.py`. This ensures dependencies are automatically resolved.
```
