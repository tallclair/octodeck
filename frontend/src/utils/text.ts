export function smartTruncate(text: string, maxLength: number): { text: string; truncated: boolean } {
  // 1. Line Truncation (Max 3 lines)
  const lines = text.split('\n');
  let processedText = text;
  let isTruncated = false;

  if (lines.length > 3) {
    processedText = lines.slice(0, 3).join('\n');
    isTruncated = true;
  }

  // 2. Length Truncation
  if (processedText.length <= maxLength) {
    return { 
        text: processedText.trim(), 
        truncated: isTruncated 
    };
  }

  // Slice initially to maxLength
  const sub = processedText.slice(0, maxLength);

  // Try to find the last sentence end (.!?) followed by space
  // We look in the last 20% of the allowed length to avoid cutting too short
  const searchRange = Math.floor(maxLength * 0.2);
  const searchStart = maxLength - searchRange;

  // Regex for sentence ending punctuation followed by whitespace or end of string
  const sentenceEndRegex = /([.!?])(\s|$)/g;
  
  let match;
  let lastSentenceEnd = -1;

  // We can't easily iterate backwards with regex in JS on a substring without slicing or loop
  // Let's just look at the substring
  while ((match = sentenceEndRegex.exec(sub)) !== null) {
      if (match.index >= searchStart) {
          lastSentenceEnd = match.index + 1; // Include the punctuation
      }
  }

  if (lastSentenceEnd !== -1) {
      return { text: sub.slice(0, lastSentenceEnd).trim(), truncated: true };
  }

  // Fallback: look for the last space
  const lastSpace = sub.lastIndexOf(' ');
  if (lastSpace >= searchStart) {
      return { text: sub.slice(0, lastSpace).trim(), truncated: true };
  }

  // Last resort: just cut at maxLength
  return { text: sub.trim(), truncated: true };
}

/**
 * Strips HTML comments from text/markdown while preserving
 * code blocks and inline code.
 */
export function stripHtmlComments(text: string): string {
  if (!text) return '';
  const pattern = /(```[\s\S]*?```|~~~[\s\S]*?~~~|(`+)[^`\n]*?\2)|<!--[\s\S]*?-->/g;
  return text.replace(pattern, (match, codeGroup) => {
    if (codeGroup !== undefined) {
      return match;
    }
    return '';
  });
}

/**
 * Returns a preview of a comment for list views.
 * Strips HTML comments, and if the first line is part of a block quote (e.g. quote-reply)
 * and there is a non-quote part to the comment, returns the text starting from the first non-block-quote line.
 */
export function getCommentPreview(text: string): string {
  if (!text) return '';

  const cleanText = stripHtmlComments(text);
  const lines = cleanText.split(/\r?\n/);

  // Find the first non-empty line
  const firstNonEmptyIdx = lines.findIndex((line) => line.trim().length > 0);
  if (firstNonEmptyIdx === -1) {
    return text.includes('<!--') ? '' : text;
  }

  // Check if the first non-empty line is a block quote
  const isBlockQuote = (line: string) => /^\s*>/.test(line);
  if (!isBlockQuote(lines[firstNonEmptyIdx])) {
    return cleanText.trim();
  }

  // Look for the first non-quote non-empty line
  const firstNonQuoteIdx = lines.findIndex(
    (line, idx) => idx >= firstNonEmptyIdx && line.trim().length > 0 && !isBlockQuote(line)
  );

  if (firstNonQuoteIdx !== -1) {
    return lines.slice(firstNonQuoteIdx).join('\n').trim();
  }

  return cleanText.trim();
}