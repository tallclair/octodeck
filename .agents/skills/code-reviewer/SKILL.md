---
name: code-reviewer
description: >-
  Initiates an open-source code review using the oss_reviewer subagent.
  Evaluates uncommitted git changes (or specified diffs) against community standards,
  security, logic correctness, performance, and test coverage.
---

# Code Reviewer Workflow

Use this skill when requested to review code, audit uncommitted changes, or perform quality checks on recent work.

---

## Workflow Steps

### 1. Identify Review Scope

By default, the review targets **uncommitted git changes** (working directory and staged files).

1. Run `git status` and `git diff --stat` to inspect the list of modified, added, or deleted files.
2. If the user explicitly requested a specific scope (e.g., a specific commit, pull request, branch, or file subset), adjust the target scope accordingly.

### 2. Aggregate Context & Intent

Before invoking the `oss_reviewer` subagent, the main agent MUST prepare a clear context summary:

1. **Goal & Intent**: Describe what the changes are supposed to accomplish, the problem being solved, or the feature being implemented.
2. **Key Components**: Identify affected architectural layers (e.g., Go backend daemon, ConnectRPC definitions, React Web App frontend, Chrome companion extension).
3. **Relevant Background**: Include relevant specs, constraints, or decisions from recent conversation history or documentation.

### 3. Invoke the Subagent (`oss_reviewer`)

Invoke the `oss_reviewer` subagent using the `invoke_subagent` tool.

**Subagent Parameters:**
- **TypeName**: `oss_reviewer`
- **Role**: `OSS Code Reviewer`
- **Prompt Format**:

```text
Please perform a code review on the following changes.

## Target Scope
- Target: [Uncommitted git changes / Specified commit or file list]
- Modified files:
[List of modified/added files from git status]

## Context & Intent
- **Goal:** [What the changes are supposed to do and why]
- **Architecture & Components:** [Affected components and layers]
- **Relevant Constraints:** [Any specific constraints, requirements, or design context]

## Instructions
1. Inspect the changes using `run_command` (`git diff`, `git status`) or `view_file`.
2. Evaluate the implementation against:
   - Logic correctness and edge cases.
   - Security vulnerabilities (OWASP top 10, secret leaks, unsanitized inputs).
   - Community standards and language idioms (Effective Go, TS/React standards).
   - Test coverage and quality.
   - Performance and maintainability.
3. Generate a "Dashboard First" review report containing Verdict, Summary Table, and Detailed Findings with actionable code fixes.
```

### 4. Process Findings & Next Steps

1. Review the report returned by `oss_reviewer`.
2. Present the findings to the user.
3. If findings require fixes, offer to assist the user or delegate fix implementation to the `implementer` subagent.
