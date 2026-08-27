import { describe, it, expect } from 'vitest';
import { getCommentPreview, smartTruncate, stripHtmlComments } from '../text';

describe('stripHtmlComments', () => {
  it('returns empty string for empty input', () => {
    expect(stripHtmlComments('')).toBe('');
  });

  it('strips inline HTML comments', () => {
    expect(stripHtmlComments('Hello <!-- comment --> World')).toBe('Hello  World');
  });

  it('strips multiline HTML comments', () => {
    const text = '<!--\nline 1\nline 2\n-->\nActual content';
    expect(stripHtmlComments(text).trim()).toBe('Actual content');
  });

  it('strips multiple comments', () => {
    const text = '<!-- c1 -->Hello<!-- c2 --> World<!-- c3 -->';
    expect(stripHtmlComments(text)).toBe('Hello World');
  });

  it('preserves HTML comments inside inline code', () => {
    const text = 'Here is `<!-- code -->` in backticks';
    expect(stripHtmlComments(text)).toBe(text);
  });

  it('preserves HTML comments inside fenced code blocks', () => {
    const text = '```html\n<!-- comment in code block -->\n```\n<!-- outside comment -->';
    expect(stripHtmlComments(text)).toBe('```html\n<!-- comment in code block -->\n```\n');
  });

  it('preserves HTML comments inside tilde code blocks', () => {
    const text = '~~~html\n<!-- comment in tilde block -->\n~~~\n<!-- outside comment -->';
    expect(stripHtmlComments(text)).toBe('~~~html\n<!-- comment in tilde block -->\n~~~\n');
  });
});

describe('getCommentPreview', () => {
  it('returns empty string for empty input', () => {
    expect(getCommentPreview('')).toBe('');
  });

  it('strips leading HTML comments from preview', () => {
    const text = '<!-- bot-id: 12345 -->\nLGTM! Looks good.';
    expect(getCommentPreview(text)).toBe('LGTM! Looks good.');
  });

  it('strips HTML comments before blockquote in quote-reply', () => {
    const text = '<!-- metadata -->\n> @octocat wrote:\n> Can you fix this?\n\nSure, I fixed it!';
    expect(getCommentPreview(text)).toBe('Sure, I fixed it!');
  });

  it('returns empty string when comment only contains HTML comments', () => {
    const text = '<!-- just a comment -->\n<!-- another comment -->';
    expect(getCommentPreview(text)).toBe('');
  });

  it('returns original text if comment does not start with a blockquote', () => {
    const text = 'Normal comment without quotes\n> quote later';
    expect(getCommentPreview(text)).toBe(text);
  });

  it('skips leading block quotes and returns the first non-block-quote line and following text', () => {
    const text = '> @octocat wrote:\n> Can you fix this?\n\nSure, I pushed the fix!\nSecond line of response';
    expect(getCommentPreview(text)).toBe('Sure, I pushed the fix!\nSecond line of response');
  });

  it('handles leading whitespace and blank lines before blockquote', () => {
    const text = '\n  \n  > Quoted text line 1\n  > Quoted text line 2\n\nI agree with the approach.';
    expect(getCommentPreview(text)).toBe('I agree with the approach.');
  });

  it('handles multiple nested quotes like >>', () => {
    const text = '>> Nested quote\n> Outer quote\n\nMy response here.';
    expect(getCommentPreview(text)).toBe('My response here.');
  });

  it('returns the original text if there are only block quotes and no non-quote part', () => {
    const text = '> Just a quote\n> Another quote line';
    expect(getCommentPreview(text)).toBe(text);
  });

  it('returns original text if comment contains only whitespace lines', () => {
    const text = '   \n   \n   ';
    expect(getCommentPreview(text)).toBe(text);
  });

  it('handles quote blocks interleaved with reply', () => {
    const text = '> First quote\n\nFirst reply\n\n> Second quote\n\nSecond reply';
    expect(getCommentPreview(text)).toBe('First reply\n\n> Second quote\n\nSecond reply');
  });

  it('handles CRLF line endings from GitHub API', () => {
    const text = '> @ndixita are you still reviewing this?\r\n\r\nI already reviewed this a few times. I will take another pass tomorrow. ';
    expect(getCommentPreview(text)).toBe('I already reviewed this a few times. I will take another pass tomorrow.');
  });
});

describe('smartTruncate', () => {
  it('truncates text beyond max length', () => {
    const text = 'This is a long line of text that exceeds the limit and should be truncated cleanly.';
    const result = smartTruncate(text, 30);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(30);
  });

  it('does not truncate text within max length', () => {
    const text = 'Short text';
    const result = smartTruncate(text, 50);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe('Short text');
  });
});
