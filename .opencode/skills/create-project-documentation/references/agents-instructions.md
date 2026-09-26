# AGENTS.md Documentation Maintenance Section

> Load when creating or reconciling the documentation-maintenance section in `AGENTS.md`.

Use this template so future changes keep the documents produced by this skill accurate. Fill every placeholder from the paths actually written during the run. Delete any line whose document does not exist rather than leaving a placeholder behind.

```markdown
## Documentation Maintenance

- The documents listed here are maintained by hand and must stay accurate.
- Before changing documented behavior, read `<CHANGELOG_PATH>`, `<ADR_INDEX>`, `<USER_GUIDE>`, `<ADMIN_GUIDE>`, and `<RELEASE_NOTES_DIR>` as applicable to the change.
- After changing behavior, configuration, commands, or supported versions, update every affected document above in the same change, or state why no documentation change was needed.
- When a document is added, renamed, split, or removed, update this list in the same change.
- Keep implemented behavior separate from planned or aspirational behavior, and never document unverified commands, endpoints, or integrations.
```

## Placeholders

| Placeholder | Fill with |
|-------------|-----------|
| `<CHANGELOG_PATH>` | The changelog written or refreshed, usually `CHANGELOG.md` |
| `<ADR_INDEX>` | The ADR index or directory, such as `docs/adr/README.md` or `docs/adr/` |
| `<USER_GUIDE>` | The end-user guide, or omit the line when the project has no end users |
| `<ADMIN_GUIDE>` | The administrator or operator guide, or omit the line when the project is not operated |
| `<RELEASE_NOTES_DIR>` | The versioned release-notes path, such as `docs/releases/` |

## Placement And Reconciliation

- Target the nearest applicable root `AGENTS.md`. If none exists, propose a root `AGENTS.md` that contains this section, so the rule is actually discovered.
- Append the section as a delimited block. Preserve every existing heading, list, and unrelated rule.
- If a section already serving the same purpose exists, edit it in place instead of appending a second one, and keep the stricter of the two rules.
- Do not paste this rule into a directory-scoped `AGENTS.md`, because a nested file can narrow or override root guidance.
- Show the exact diff and get confirmation before writing. If the user declines, leave `AGENTS.md` unchanged and report that upkeep instructions were not installed.
