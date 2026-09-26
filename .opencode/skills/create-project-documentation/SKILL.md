---
name: create-project-documentation
description: "Create or refresh a complete software-project documentation suite: ADRs, user guide, administrator guide, changelog, versioned release notes, platform runbooks that state what is not live-verified, human-gate review files, and research probe reports. Then install AGENTS.md instructions that keep those documents current. Use when a project needs launch documentation, a documentation audit, release preparation, evidence artefacts, consistent operational and user-facing docs, or documentation upkeep as the project changes."
---

# Create Project Documentation

Use this skill to turn an implemented project into a coherent, fact-checked documentation set. It works for applications, libraries, services, CLIs, platforms, and monorepos. Document implemented behavior separately from roadmap or aspirational behavior.

Three artefact shapes recur in projects that ship on more than one platform, or that gate work on human judgement: **platform runbooks** that must say plainly what is not live-verified, **human-gate review files** written against a fixed acceptance shape, and **research probe reports** that distinguish a signal that is absent from one that was never triggered. Load the matching reference before writing any of the three.

## Process

1. **Inventory the project.** Inspect the existing README and docs, source and deployment layout, configuration and environment examples, package/project manifests, test/build scripts, version files, tags, and recent history. Identify user personas, operators, deployment targets, security boundaries, and supported integrations.
2. **Resolve scope and version.** Prefer an existing tag or package/application version. If versions disagree, then report the conflict and use the authoritative release source; do not silently invent a version. If no release exists, then use `Unreleased` unless the requester supplies a version. Separate current behavior, known limitations, and planned work.
3. **Create the document set.** Use the templates listed under Outputs below as a starting point. Create only applicable sections, but do not omit a requested artifact. For a project with no end users or administrators, state that the role is not applicable and document the relevant developer/operator workflow instead.
4. **Write ADRs from evidence.** Record durable architectural decisions, not every implementation detail. Each ADR must include status, date, context, decision, alternatives, consequences, and implementation references. Link the ADR index from the README.
5. **Write task-oriented guides.** The user guide should describe goals, workflows, visible states, recovery, accessibility, and privacy. The administrator guide should describe prerequisites, installation, configuration, secrets, operations, backups, upgrades, troubleshooting, and security hardening. Use exact commands and configuration names found in the project.
6. **Prepare release communication.** Add a Keep a Changelog-compatible changelog and release notes for the resolved version. Include highlights, compatibility, installation/upgrade notes, known limitations, validation status, and links to detailed docs. Do not claim tests, integrations, or production support that were not verified.
7. **Write the evidence artefacts.** If the project ships on multiple platforms, has human review gates, or has unresolved external integrations, write the runbook, review file, and probe report shapes. Mark each unverified path explicitly rather than letting absence read as success.
8. **Refresh navigation and stale docs.** Correct stale status statements in component docs and add links to canonical guides and release notes. Preserve historical requirements and design documents; label their status rather than rewriting history.
9. **Install documentation upkeep instructions.** Find the nearest applicable `AGENTS.md`. If one exists, then reconcile a delimited documentation-maintenance section in place instead of appending a duplicate; if none exists, then propose a root `AGENTS.md` containing that section. Name the document paths actually written in this run rather than generic placeholders, and drop entries for documents that were not created. Show the exact diff and obtain confirmation before writing. If the user declines, then leave `AGENTS.md` unchanged and report that upkeep instructions were not installed. Load `references/agents-instructions.md` when drafting or editing this section.
10. **Validate.** Run the checks below, then the project's own gates.

## Required Evidence Rules

- Prefer source code, manifests, deployment files, tests, and observed command output over requirements documents when describing current behavior.
- Treat unchecked task lists and roadmap statements as plans unless implementation evidence confirms completion.
- Never publish passwords, tokens, private URLs, signing keys, or copied secret values. Show variable names and safe placeholders only.
- Explain delivery semantics precisely. "At least once with idempotent effect" is not the same as transport-level exactly once.
- Mark consumer-owned responsibilities, such as workflow authorization or audit, instead of assigning them to this project.
- State what is **not** verified as prominently as what is. An unverified path that is merely undocumented reads as a verified path downstream.

## Evidence Artefacts

Three shapes recur. Write each only when the project has the corresponding condition, and never
let a missing artefact imply a passing one.

### Platform runbooks

Required when a project implements a path for a platform the authoring machine cannot run. The
runbook must state, per platform, the exact command a developer can run to reproduce the
behaviour by hand, which parts are covered by automated tests, and which parts can only be
confirmed on that platform. The not-live-verified statement must appear in the runbook body, not
only in a status table elsewhere.

Load `references/platform-runbook.md` when writing or updating a runbook for a platform path that
was not executed on the authoring machine.

### Human-gate review files

Required when a project gates work on human judgement. A review file is evidence of a
*human* observation, written against a fixed acceptance shape so verdicts are comparable across
gates. It records the reviewer, the platform, the journey performed, one verdict per acceptance
criterion, timings, and what remains outstanding.

The critical rule: an agent may **prepare** the shape and check that a verdict is complete, but
must never author, infer, or close a verdict. A generated verdict is fabricated evidence.

Load `references/human-review-file.md` when a project has human review gates, or when a review
file needs to be created, validated for completeness, or reconciled.

### Research probe reports

Required when an external capability is unresolved and the project proceeds under an assumption.
A probe report holds the **verbatim** captured evidence with timestamps and exact tool versions,
so a later reader can re-check the conclusion rather than trust it. The report must distinguish
three states, never two: a signal that is **absent** (confirmed not to exist), one that is
**untriggered** (exists, fired, carried nothing), and one that is **unclear** (not yet
determined).

Load `references/probe-report.md` when writing a probe report, or when a conclusion needs to be
distinguished from its evidence.

## Outputs

Default paths are `CHANGELOG.md`, `docs/adr/`, `docs/user-guide.md`, `docs/admin-guide.md`, `docs/releases/`, `docs/runbooks/`, `docs/reviews/`, and `docs/research/`, plus a `Documentation Maintenance` section in `AGENTS.md`. Adapt paths to the repository's existing convention when one exists, and keep the upkeep section's paths in step with the documents actually produced. Keep `SKILL.md` generic; project facts belong in generated documentation.

Load these references when writing the corresponding artifact:

- Load `references/adr-template.md` when creating or updating an ADR.
- Load `references/user-guide-template.md` when the project has end users or a client workflow.
- Load `references/admin-guide-template.md` when the project is deployed, hosted, configured, or operated.
- Load `references/changelog-template.md` when establishing or refreshing change history.
- Load `references/release-notes-template.md` when preparing a versioned release.
- Load `references/platform-runbook.md` when documenting a platform path that was not executed on the authoring machine.
- Load `references/human-review-file.md` when a project has human review gates.
- Load `references/probe-report.md` when an external capability is unresolved under an assumption.
- Load `references/agents-instructions.md` when creating or reconciling the `AGENTS.md` documentation-maintenance section.

## Validation Checklist

- [ ] Requested documents exist and are linked from the README or documentation index.
- [ ] Version and release date agree with the authoritative version source.
- [ ] No credentials or secrets are present.
- [ ] Commands, ports, paths, environment variables, and endpoints match the repository.
- [ ] Current, planned, and unsupported behavior are clearly distinguished.
- [ ] ADRs have stable identifiers and complete decision sections.
- [ ] User and administrator audiences are clearly separated.
- [ ] Release notes link to upgrade, user, and administrator guidance.
- [ ] Every runbook states per platform which parts were executed and which were not.
- [ ] Every human review file has one verdict per acceptance criterion and names its reviewer and platform.
- [ ] Every probe report holds verbatim captures with tool versions and timestamps.
- [ ] `AGENTS.md` contains a single documentation-maintenance section naming the documents created in this run, reconciled rather than duplicated.
- [ ] Local Markdown links resolve, including links from nested docs.
- [ ] Build, test, lint, and documentation checks have been run where available.

Run the project's own gates before declaring the set consistent. Otherwise fall back to the
following when the project defines no scripts:

```bash
git diff --check
rg -n "TODO|FIXME|XXX" --glob '*.md' docs/
git status --porcelain
```

## Gotchas

- **A runbook that omits the unverified statement.** The commands and tests are all present, so it reads as complete, and every downstream document inherits the claim. Put the not-live-verified statement in the runbook body, per platform.

- **An agent-authored review verdict.** Generating the JSON shape is helpful; filling in the verdict is fabricated human evidence. Prepare and validate the shape, and leave the verdict for a person.

- **Collapsing "absent" and "untriggered" in a probe report.** A signal that does not exist and a signal that fired with nothing in it need different conclusions, and merging them turns a capability gap into a quiet observation.

- **A probe report that summarizes instead of capturing.** A conclusion a later reader cannot re-check is an assertion, not evidence. Store the verbatim payload, the exact tool version, and the timestamp.

- **Stale implementation status.** Feature documents often retain unchecked planning tasks after code lands. Verify against source, tests, and progress records, then label historical checklists instead of presenting them as current truth.

- **Version drift.** Monorepos commonly contain several package versions and an app version. Identify which version defines the release, document other package versions as component versions, and do not mass-replace unrelated dependency versions.

- **Deployment-only settings.** A variable shown in a Compose file may be development-only or intentionally unsafe outside a trusted network. Explain its scope and never present insecure development flags as production instructions.

- **False integration claims.** A contract stub, mock, or provider test does not prove compatibility with a live external product. Name the validation boundary and the untested external runtime explicitly.

- **Broken nested links.** Relative links are resolved from the linking file, not from the repository root. Validate links after moving content and use paths relative to each document.

- **Upkeep rules drift from the document set.** An `AGENTS.md` section is only useful while it matches reality. Fill it from the paths actually written, prune entries for documents that were not created or were renamed, and reconcile it whenever the document set changes.

- **Appending duplicates the rule.** Two documentation-maintenance sections leave precedence ambiguous. Reconcile the existing section in place, keep the stricter of the two rules, and preserve unrelated prose. If no `AGENTS.md` exists, create a root file rather than a directory-scoped one that will not be discovered.

- **Nested `AGENTS.md` overrides root.** A directory-scoped file can narrow or override root guidance. Do not paste root-wide maintenance authority into a nested file, and check for a conflicting scoped rule before editing the root file.

- **An unquoted description with a colon breaks the frontmatter.** A `description` value containing `: ` fails YAML parsing, which silently hides the skill's name and description from discovery. Quote the value.
