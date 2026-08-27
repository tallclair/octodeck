# OctoDeck Feature Requests

This document tracks proposed and planned feature requests for OctoDeck.

## Planned

### Tags

Tags are like private labels. The user defines them, and can add them to any items. They're visible from the dashboard, details pane, and directly on github (via extension). There is a filter selector for tags.

#### Tag rules? (TBD)

Automatic tagging. Still under consideration.

## Backlog

### AI Reviews

See [autoreview_design.md](autoreview_design.md)

### Generalized noise filtering

Add a configuration field that holds a list of regexes that are applied to comments to tag them as noise. Make the slash command filtering just the default for the generalized noise filter.

### Filter Out Slash Commands and Boilerplate from Descriptions
- **Status:** Proposed
- **Description:** Automatically filter out bot slash commands, command instructions (e.g., `/hold`, `/lgtm`, `/assign`, `/kind bug`, `/retest`), empty release-notes codeblocks, and orphaned section headers from issue and PR opening descriptions, with a UI toggle to show the full original text.
- **Rationale:** PR templates and issue descriptions (especially in large projects like Kubernetes) frequently include boilerplate slash commands, release note placeholders, and instruction headers that clutter the maintainer's reading experience. Filtering them out by default keeps descriptions focused on the actual changes while preserving the ability to inspect the raw template.
- **Key Requirements:**
  - **Slash Command Stripping:** Remove lines consisting of bot slash commands (such as `/kind bug`, `/priority important-soon`, `/assign @user`, `/lgtm`).
  - **Empty / NONE Release Notes Filter:** Hide ```` ```release-notes ```` code blocks when the only content inside is `"NONE"` (or empty/whitespace).
  - **Orphaned Header Cleanup:** If removing slash commands or boilerplate leaves a markdown header section with no remaining content (e.g., `# What type of PR is this?` followed only by `/kind bug`), strip the header as well.
    - *Example Transformation:*
      ```markdown
      # What type of PR is this?
      /kind bug

      # What this PR does / why we need it:
      Fixes a regression in the scheduler.
      ```
      becomes:
      ```markdown
      # What this PR does / why we need it:
      Fixes a regression in the scheduler.
      ```
  - **Raw View Toggle:** Provide a UI toggle (such as "Show full description" / "Hide boilerplate") in `DetailsPane` whenever content has been filtered.
- **Implementation Outline:**
  - [ ] **Sanitization Logic (`markdownFilter.ts` / `noiseFilter.ts`):**
    - Strip slash command lines.
    - Parse/strip ```` ```release-notes\nNONE\n``` ```` blocks.
    - Post-process markdown AST or lines to remove markdown header lines that have no succeeding content before the next header or end of text.
  - [ ] **UI Toggle Component:** In `DetailsPane.tsx` (or `Markdown.tsx`), render a toggle button to switch between filtered and raw description text.
  - [ ] **Unit Tests:** Add test cases covering Kubernetes PR templates, release-notes blocks with `NONE` vs actual notes, nested markdown headers, code blocks with slash comments (which should NOT be stripped), and toggle interaction.
