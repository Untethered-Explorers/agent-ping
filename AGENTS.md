## Documentation Map Maintenance

- Before changing code or behavior, check the relevant entries in `docmap.jsonl` and read the mapped source documents for the affected area.
- When several mapped documents may be affected, check `critical` and `high` priority entries first, then review `normal` and `low` entries as relevant.
- After changing code or behavior, update every affected mapped document or explain why no documentation change is needed.
- When a document is added, removed, renamed, or changes from source to generated output, update `docmap.jsonl` in the same change.
- Keep paths in `docmap.jsonl` repository-relative and do not add generated or vendored documents unless explicitly approved.
- Use the map's document groups, authority/purpose, and `update_when` fields to identify the source-of-truth documents that need review; do not update every document mechanically.
- The `reference-check` checklist record in `docmap.jsonl` lists the cross-document checks to run before publishing a documentation change.
