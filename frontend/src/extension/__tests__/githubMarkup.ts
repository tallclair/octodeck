/**
 * Hand-built GitHub markup for shapes the sanitized fixtures don't contain yet. Mirror real
 * GitHub structure (classes, attributes); never include page text beyond control labels.
 */

/** A review thread's hidden-replies loader, as GitHub renders it inside a review thread. */
export function threadLoader(ids: string): HTMLFormElement {
  const form = document.createElement('form');
  form.className = 'ajax-pagination-form js-ajax-pagination review-comment-loader js-thread-hidden-comment-ids';
  form.setAttribute('action', '/o/r/pull/1/threads/9/more_comments?after=1&before=2');
  form.setAttribute('method', 'get');
  form.setAttribute('data-hidden-comment-ids', ids);
  const button = document.createElement('button');
  button.type = 'submit';
  button.setAttribute('data-disable-with', '');
  button.textContent = 'Load more…';
  form.append(button);
  return form;
}
