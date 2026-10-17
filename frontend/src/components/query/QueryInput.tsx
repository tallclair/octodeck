// The dashboard query input: a native auto-growing <textarea> holding the query text, drawn over
// a decoration layer that puts a tinted pill exactly on each clause's glyphs (§6). Focus only
// cross-fades the pill surfaces; no glyph ever moves. At rest, hovering a pill with the mouse
// reveals an inset remove button. State and native-editing plumbing live in useQueryField.
import type { ReactNode, Ref } from 'react';
import { AlertTriangle, Search, X } from 'lucide-react';
import type { QueryEditKind } from '../../hooks/useDashboardFilters';
import { useQueryField } from '../../hooks/useQueryField';
import type { QuerySuggestionFacets } from '../../hooks/useQuerySuggestions';
import { clauseTone, hasBadSegment, normalizeQuerySpacing } from '../../logic/query/clauseDisplay';
import { toPlaceholderDisplay } from '../../logic/query/displayText';
import type { ServerInvalidQuery } from '../../logic/query/predicates';
import type { PillBox } from '../../logic/query/fieldGeometry';
import { segmentClause } from '../../logic/query/syntax';
import type { SavedSearchView } from '../../logic/savedSearches';
import { PinButton } from '../savedSearches/PinButton';
import {
  ERROR_UNDERLINE_CLASS,
  PILL_METRICS,
  PILL_OVERLAY_CLASS,
  QUERY_CLEAR_BUTTON_CLASS,
  QUERY_MAX_TEXT_HEIGHT_PX,
  QUERY_MIN_TEXT_HEIGHT_PX,
  QUERY_SUMMARY_CLASS,
  QUERY_TEXTAREA_CLASS,
  QUERY_TEXT_BOX_CLASS,
  QUERY_TEXT_BOX_STYLE,
  SEARCH_ICON_SIZE_PX,
  SEARCH_ICON_STYLE,
  pillClass,
  queryFrameClass,
  querySearchIconClass,
  removeButtonClass,
  removeIconClass,
  segmentClass,
} from './queryInputStyles';
import { SuggestionList } from './SuggestionList';

export const DEFAULT_QUERY_PLACEHOLDER = 'Filter or search, e.g. is:open label:bug';

export interface QueryInputProps {
  readonly value: string;
  readonly onChange: (text: string, kind: QueryEditKind) => void;
  readonly onClear?: () => void;
  readonly invalidQuery?: ServerInvalidQuery | null;
  readonly facets?: QuerySuggestionFacets;
  readonly placeholder?: string;
  readonly inputRef?: Ref<HTMLTextAreaElement>;
  readonly textareaTestId?: string;
  readonly activeSearch?: SavedSearchView | null;
  readonly originSearch?: SavedSearchView | null;
  readonly isOriginModified?: boolean;
  readonly onPinClick?: () => void;
}

export function QueryInput({
  value,
  onChange,
  onClear,
  invalidQuery,
  facets,
  placeholder = DEFAULT_QUERY_PLACEHOLDER,
  inputRef,
  textareaTestId,
  activeSearch,
  originSearch,
  isOriginModified,
  onPinClick,
}: QueryInputProps) {
  const {
    field,
    refs: { textareaRef, frameRef, mirrorRef, popupRef },
  } = useQueryField({
    value,
    onChange,
    onClear,
    invalidQuery,
    facets,
    inputRef,
    pillMetrics: PILL_METRICS,
  });
  const { ids, display, parsed, errors, suggestions: sugg, hover, boxes } = field;
  const listOpen = sugg.open && sugg.result !== null;
  const normalized = normalizeQuerySpacing(field.text);

  // Decoration layer content: each clause's coloured glyphs inline (exactly where the
  // textarea's transparent glyphs are) and the raw whitespace between them. The pill surfaces
  // are painted separately as boxes behind the glyphs (see `boxes`).
  const tones = parsed.clauses.map((clause, i) =>
    clauseTone(clause, i === field.caretClause, errors.serverClauseErrors.has(i))
  );
  const parts: ReactNode[] = [];
  let pos = 0;
  parsed.clauses.forEach((clause, i) => {
    if (clause.start > pos) parts.push(display.slice(pos, clause.start));
    const serverError = errors.serverClauseErrors.has(i);
    const tone = tones[i];
    const segments = segmentClause(clause);
    const wholeClauseError = tone === 'error' && !hasBadSegment(segments);
    parts.push(
      <span
        key={clause.start}
        data-testid="query-pill"
        data-clause={i}
        data-status={serverError ? 'error' : clause.status}
        data-tone={tone}
        data-negated={clause.negated ? 'true' : undefined}
        className={wholeClauseError ? ERROR_UNDERLINE_CLASS : undefined}
      >
        {segments.map((s) => (
          <span key={s.start} className={segmentClass(tone, s.role)}>
            {display.slice(s.start, s.end)}
          </span>
        ))}
      </span>
    );
    pos = clause.end;
  });
  if (pos < display.length) parts.push(display.slice(pos));

  const hoverClause = hover ? parsed.clauses[hover.index] : undefined;
  const hoverBox = hover ? boxes.find((b) => b.index === hover.index && b.last) : undefined;
  const boxStyle = (b: PillBox) => ({ left: b.left, top: b.top, width: b.width, height: b.height });
  const descriptionText = `Current query: ${normalized || 'empty'}${
    errors.summary ? `. ${errors.summary}` : ''
  }`;

  return (
    <div className="w-full">
      <div
        ref={frameRef}
        role="group"
        aria-label="Query"
        className={queryFrameClass(field.focused)}
        onMouseMove={field.frameProps.onMouseMove}
        onMouseLeave={field.frameProps.onMouseLeave}
      >
        {/* Decoration layer, in normal flow so it sets the field height (grows by line, capped). */}
        <div
          aria-hidden="true"
          className="relative overflow-hidden rounded-[inherit]"
          style={{ maxHeight: QUERY_MAX_TEXT_HEIGHT_PX }}
        >
          {/* Pill surfaces, behind the glyphs; they scroll with the text. */}
          <div className="absolute left-0 top-0">
            {boxes.map((b) =>
              tones[b.index] === undefined ? null : (
                <span
                  key={`${parsed.clauses[b.index].start}:${b.top}:${b.first ? 'f' : ''}`}
                  data-pill-box={b.index}
                  className={pillClass(
                    tones[b.index],
                    !field.focused || b.index === field.caretClause,
                    b.first,
                    b.last
                  )}
                  style={boxStyle(b)}
                />
              )
            )}
          </div>
          <div
            ref={mirrorRef}
            data-testid="query-decorations"
            className={`${QUERY_TEXT_BOX_CLASS} relative select-none`}
            style={{
              ...QUERY_TEXT_BOX_STYLE,
              minHeight: QUERY_MIN_TEXT_HEIGHT_PX,
            }}
          >
            {parts}
            {/* Measures a trailing space or empty last line like the textarea does. */}
            {'\u200b'}
          </div>
          {/* The hovered pill's last box again, above the textarea (no stacking context on the
              wrapper), holding the remove button inside its border. */}
          {hover && hoverClause && hoverBox && (
            <div className="absolute left-0 top-0 z-30">
              <div className={PILL_OVERLAY_CLASS} style={boxStyle(hoverBox)}>
                <button
                  key={`${hover.index}:${hoverClause.start}`}
                  type="button"
                  tabIndex={-1}
                  data-remove-clause={hover.index}
                  aria-label={`Remove ${hoverClause.raw}`}
                  title="Remove"
                  onMouseDown={(e) => {
                    // Never take focus or move the caret; the click does the edit.
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onClick={() => field.removeClause(hover.index)}
                  className={removeButtonClass(clauseTone(hoverClause, false, errors.serverClauseErrors.has(hover.index)))}
                >
                  <span
                    className={removeIconClass(
                      clauseTone(hoverClause, false, errors.serverClauseErrors.has(hover.index))
                    )}
                  >
                    <X size={12} strokeWidth={2.5} aria-hidden="true" />
                  </span>
                </button>
              </div>
            </div>
          )}
        </div>

        <textarea
          ref={textareaRef}
          data-testid={textareaTestId}
          rows={1}
          role="combobox"
          aria-label="Filter or search query"
          aria-autocomplete="list"
          aria-expanded={listOpen}
          aria-controls={ids.listbox}
          aria-activedescendant={listOpen ? `${ids.option}-${sugg.active}` : undefined}
          aria-describedby={ids.description}
          aria-invalid={errors.messages.length > 0 || undefined}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={toPlaceholderDisplay(placeholder)}
          className={QUERY_TEXTAREA_CLASS}
          style={QUERY_TEXT_BOX_STYLE}
          {...field.textareaProps}
        />

        <Search
          size={SEARCH_ICON_SIZE_PX}
          aria-hidden="true"
          className={querySearchIconClass(field.focused)}
          style={SEARCH_ICON_STYLE}
        />

        {onPinClick && (
          <PinButton
            queryText={field.text}
            parsed={parsed}
            hasServerError={errors.serverClauseErrors.size > 0 || Boolean(invalidQuery)}
            activeSearch={activeSearch}
            originSearch={originSearch}
            isOriginModified={isOriginModified}
            insetPosition={field.text !== '' ? 'left-of-clear' : 'right-edge'}
            onClick={onPinClick}
          />
        )}

        {field.text !== '' && (
          <button
            type="button"
            aria-label="Clear query"
            title="Clear query"
            data-testid="clear-query-button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={field.clearAll}
            className={QUERY_CLEAR_BUTTON_CLASS}
          >
            <X size={12} aria-hidden="true" />
          </button>
        )}

        {listOpen && sugg.result && (
          <div ref={popupRef} className="absolute z-40 h-0" style={{ left: 0, top: '100%' }}>
            <SuggestionList
              id={ids.listbox}
              optionIdPrefix={ids.option}
              items={sugg.result.items}
              active={sugg.active}
              onHover={sugg.setActive}
              onPick={(s) => field.acceptSuggestion(s, 'Enter')}
            />
          </div>
        )}

        <span id={ids.description} className="sr-only">
          {descriptionText}
        </span>
        <div role="status" aria-live="polite" className="sr-only">
          {field.announcement.text ? (
            <span key={field.announcement.seq}>{field.announcement.text}</span>
          ) : null}
        </div>
      </div>
      {errors.summary && (
        <div data-testid="invalid-query" className={QUERY_SUMMARY_CLASS}>
          <AlertTriangle
            size={12}
            className="shrink-0 text-slate-400 dark:text-slate-500"
            aria-hidden="true"
          />
          <span>{errors.summary}</span>
        </div>
      )}
    </div>
  );
}
