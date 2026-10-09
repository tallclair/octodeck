// Throwaway UX prototype: live readout of how the query text is interpreted.

import { summarize } from './parser';

export default function ParsedReadout({ text }: { text: string }) {
  const s = summarize(text);
  return (
    <div className="mt-4 text-xs space-y-2">
      <div className="font-bold uppercase tracking-wider text-slate-500">Parsed</div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-slate-400 dark:text-slate-500">
            <th className="font-medium py-1 pr-2">field</th>
            <th className="font-medium py-1 pr-2">values (OR)</th>
            <th className="font-medium py-1 pr-2">negated</th>
            <th className="font-medium py-1">note</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {s.tokens.map((t, i) => {
            const rowClass =
              t.status === 'error'
                ? 'text-red-600 dark:text-red-400'
                : t.status === 'incomplete'
                  ? 'text-slate-400 dark:text-slate-500 italic'
                  : 'text-slate-700 dark:text-slate-300';
            const p = t.predicates[0];
            return (
              <tr key={`${i}:${t.raw}`} className={`border-t border-slate-100 dark:border-slate-800 align-top ${rowClass}`}>
                <td className="py-1 pr-2">{p?.field ?? t.key?.text ?? '?'}</td>
                <td className="py-1 pr-2 break-all">
                  {p ? p.values.map((v) => JSON.stringify(v)).join(', ') : <span className="line-through">{t.raw}</span>}
                </td>
                <td className="py-1 pr-2">{t.negated ? 'yes' : ''}</td>
                <td className="py-1 font-sans">{t.message ?? (t.raw.startsWith('is:') && p ? `from ${t.raw}` : '')}</td>
              </tr>
            );
          })}
          {s.tokens.length === 0 && (
            <tr>
              <td colSpan={4} className="py-1 text-slate-400 font-sans italic">
                Empty query
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {s.implicitInbox && <div className="text-slate-400 dark:text-slate-500">+ implicit triage:inbox (no triage predicate)</div>}
      <div className="text-slate-500 dark:text-slate-400">
        Canonical: <code className="font-mono text-slate-700 dark:text-slate-300 break-all">{s.canonical || '—'}</code>
      </div>
      <div className="text-slate-500 dark:text-slate-400">
        Raw text: <code className="font-mono text-slate-700 dark:text-slate-300 break-all whitespace-pre-wrap">{JSON.stringify(text)}</code>
      </div>
    </div>
  );
}
