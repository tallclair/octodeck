// Throwaway UX prototype page: compares the two Phase 2 query-input designs
// (docs/internal/query_model_design.md §7.1) side by side. Not wired to the API.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Moon, Sun } from 'lucide-react';
import TokenizedInput from './TokenizedInput';
import OverlayInput from './OverlayInput';
import ParsedReadout from './ParsedReadout';

const EXAMPLES = [
  'is:open repo:kubernetes/kubernetes label:"good first issue" -author:k8s-ci-robot flaky test',
  'new:mention,code is:pr',
  'is:open,pr',
  'state:opne typ:pr "exact phrase" #1234',
  'triage:all -is:new no:assignee',
  'is:open is:pr repo:kubernetes/kubernetes,kubernetes/enhancements label:sig/node,kind/flake -label:lgtm,approved milestone:v1.35 assignee:@me in:title kubelet restart eviction',
];

function Panel(props: { title: string; description: string; tips: string[]; text: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-5 min-w-0">
      <h2 className="font-semibold text-slate-900 dark:text-slate-100">{props.title}</h2>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">{props.description}</p>
      {props.children}
      <ParsedReadout text={props.text} />
      <details className="mt-4 text-xs text-slate-500 dark:text-slate-400">
        <summary className="cursor-pointer">Things to try</summary>
        <ul className="list-disc pl-5 mt-1 space-y-0.5">
          {props.tips.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

export default function QueryInputPrototype() {
  const [loaded, setLoaded] = useState({ version: 0, text: EXAMPLES[0] });
  const [tokText, setTokText] = useState(EXAMPLES[0]);
  const [ovlText, setOvlText] = useState(EXAMPLES[0]);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));

  const load = (text: string) => {
    setLoaded((l) => ({ version: l.version + 1, text }));
    setTokText(text);
    setOvlText(text);
  };

  const toggleDark = () => {
    document.documentElement.classList.toggle('dark', !dark);
    setDark(!dark);
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200 p-6">
      <header className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h1 className="text-lg font-bold">Query input prototype</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Phase 2 design comparison (query_model_design.md §7.1). Mock parser and autocomplete values; not connected to the daemon.
          </p>
        </div>
        <button
          type="button"
          onClick={toggleDark}
          className="p-2 rounded-md border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-900 cursor-pointer"
          aria-label="Toggle dark mode"
        >
          {dark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </header>

      <div className="mb-6">
        <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Examples (load into both)</div>
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => load(ex)}
              className="text-left font-mono text-xs px-2 py-1 rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-blue-400 cursor-pointer max-w-full truncate"
            >
              {ex}
            </button>
          ))}
          <button
            type="button"
            onClick={() => load('')}
            className="text-xs px-2 py-1 rounded-md text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6 items-start">
        <Panel
          title="Option 1: Tokenized input"
          description="Gmail/Linear style: finished key:value tokens become chips; only the token under the caret is editable text."
          text={tokText}
          tips={[
            'Type "lab" then pick label: and a value; Enter commits a chip, Tab completes so you can type "," for another value.',
            'Space finishes a token (except inside quotes, e.g. label:"good first issue").',
            'Backspace or ArrowLeft at the start of the text opens the previous chip; ArrowRight/Delete at the end opens the next.',
            'Click into the middle of a chip value: it becomes text with the caret where you clicked.',
            'Home / End jump across all chips. Hover a red chip for its error. The x removes a chip.',
            'Paste a full query string into the box.',
          ]}
        >
          <TokenizedInput key={loaded.version} initial={loaded.text} onChange={setTokText} />
        </Panel>
        <Panel
          title="Option 2: Highlighted overlay"
          description="GitHub search style: plain free-form text; recognised qualifiers are drawn as pills behind the text (visual only)."
          text={ovlText}
          tips={[
            'Edit anywhere with normal text editing: select across qualifiers, double-click words, Ctrl+A, copy/paste.',
            'Autocomplete follows the caret: put it after "label:" or after a comma.',
            'Arrow Up/Down on an empty spot opens key suggestions.',
            'Long queries wrap and the box grows.',
          ]}
        >
          <OverlayInput key={loaded.version} initial={loaded.text} onChange={setOvlText} />
        </Panel>
      </div>
    </div>
  );
}
