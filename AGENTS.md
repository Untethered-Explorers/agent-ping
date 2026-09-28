## Documentation Map Maintenance

- Before changing code or behavior, check the relevant entries in `docmap.jsonl` and read the mapped source documents for the affected area.
- When several mapped documents may be affected, check `critical` and `high` priority entries first, then review `normal` and `low` entries as relevant.
- After changing code or behavior, update every affected mapped document or explain why no documentation change is needed.
- When a document is added, removed, renamed, or changes from source to generated output, update `docmap.jsonl` in the same change.
- Keep paths in `docmap.jsonl` repository-relative and do not add generated or vendored documents unless explicitly approved.
- Use the map's document groups, authority/purpose, and `update_when` fields to identify the source-of-truth documents that need review; do not update every document mechanically.
- The `reference-check` checklist record in `docmap.jsonl` lists the cross-document checks to run before publishing a documentation change.

## Cross-Platform Development

This project supports **Linux, macOS and Windows**. The `os` field in `package.json` is the authoritative statement of that contract, and every path this product writes resolves through `src/storage/paths.ts`. Agents MUST treat their own operating system as an implementation detail, not as an assumption about the target environment.

Detailed requirements are documented in [docs/cross-platform.md](docs/cross-platform.md).

### Core rules

- Never assume the work runs on the agent's own operating system unless the task says so explicitly.
- Resolve every path through the platform-aware APIs in `src/storage/paths.ts`. Never hard-code a filesystem path, and never build one by string concatenation or a literal separator.
- Prefer the platform-neutral `node:` runtime APIs over shelling out, and pass an executable plus an argument array rather than a command string.
- Never assume Bash, PowerShell or any Unix utility is available, and never write shell syntax into a file another process executes — the three autostart units are read by three different interpreters.
- Treat a path as an opaque value that may contain spaces, Unicode, parentheses, apostrophes or other metacharacters, and quote it for the interpreter that will read it.
- Do not rely on Unix permission bits, symlink support, or Unix process-signal and process-tree behaviour. A `chmod` that the platform or filesystem refuses is expected to be survivable, not fatal.
- Do not assume LF line endings, a case-insensitive filesystem, a particular home, temporary or config directory, a username, a drive letter, or an executable extension.
- Do not assume a particular CPU architecture: `electron` and the native `better-sqlite3` module resolve per platform, and `package.json` declares no `cpu` constraint.
- Keep a platform branch in the module that owns that platform — the autostart units live beside `src/cli/autostart/linux.ts`, `macos.ts` and `windows.ts` and are dispatched from `index.ts` — rather than in a conditional threaded through shared code.
- A module that generates a file for *another* platform may deliberately use that platform's `path` flavour; everything else uses the ambient platform.
- Tests MUST NOT depend on the developer's OS, shell, locale, timezone, username, home directory or filesystem layout. Drive a platform branch through injected `env` and `platform` parameters, as `resolveStateDir` already does, rather than mutating `process.env`.

### Scripts and automation

Repository automation is Node ESM under `scripts/`, invoked as `node scripts/<name>.mjs`. When adding or changing one:

1. Keep it a Node module. Do not introduce a shell script.
2. Spawn an executable with an argument array; never build a command string for a shell to parse.
3. Do not embed platform-specific path or environment-variable syntax in a generated configuration file.
4. Resolve temporary directories with `os.tmpdir()` and create them with `fs.mkdtempSync`, never `/tmp`.
5. Report a missing external tool by name rather than assuming it is installed.

### Installation and execution

`agent-ping install`, `uninstall`, `status` and `doctor`, the per-platform autostart units, the npm `files` allowlist and the `prepack` guard are the surfaces where an OS assumption becomes a user-visible failure. Review changes to them for filesystem semantics, permissions, native dependencies, executable naming, process management, environment variables and configuration locations. The per-platform unit table and the state-layout contract are owned by `docs/admin-guide.md`; this section does not restate them.

### Completion requirement

Before declaring work complete, perform a cross-platform compatibility review of any new or changed script, installer, build configuration, process management, filesystem operation, environment or configuration handling, native dependency, developer tool, or CI automation.

**Important:** Do not fix a portability failure merely by adding another OS-specific workaround. First determine whether the underlying implementation can be made platform-neutral.
