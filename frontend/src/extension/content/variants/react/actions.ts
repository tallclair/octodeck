/**
 * Action classifier for GitHub's React issue viewer
 * (docs/internal/extension_dom_engine_design.md section 6.5).
 *
 * The React issue page has no <form> elements, so its writes are detected from clicks and
 * keyboard shortcuts (the "Comment" / "Close issue" buttons, Ctrl/Cmd+Enter in the composer,
 * option selection in sidebar pickers). Those rules are shared with the classic classifier, whose
 * page shell is React as well; this module reuses it so both variants evolve together.
 */
import type { ActionAdapter } from '../types';
import { classifyGitHubAction } from '../classic/actions';

export const reactActionAdapter: ActionAdapter = {
  classify: classifyGitHubAction,
};
