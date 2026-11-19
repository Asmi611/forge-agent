/**
 * EOL-insensitive search/replace edit application (Milestone E-05).
 *
 * Slices replacements into the original document text, preserving untouched bytes
 * (including mixed CRLF/LF line endings) byte-identically.
 * Requires each edit's oldText to match exactly once.
 */

export interface EditItem {
  oldText: string;
  newText: string;
}

export interface ApplyEditsOptions {
  path?: string;
}

export type ApplyEditsResult =
  | { ok: true; text: string }
  | { ok: false; reason: string; hint?: { startLine: number; endLine: number } };

/**
 * Escapes a string for use in a regular expression while making newlines
 * EOL-insensitive so that \n in oldText matches both \r\n and \n in original text.
 */
function escapeRegexForEol(str: string): string {
  const normalized = str.replace(/\r\n/g, '\n');
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(/\n/g, '(?:\\r?\\n)');
}

/**
 * Determines whether text dominantly uses CRLF line endings.
 */
function isDominantlyCrlf(text: string): boolean {
  const crlfCount = (text.match(/\r\n/g) || []).length;
  const lfCount = (text.match(/(?<!\r)\n/g) || []).length;
  return crlfCount > lfCount;
}

/**
 * Applies search/replace edits against original text.
 *
 * Each edit's oldText must match exactly once in the original document.
 * Splicing is performed from the highest offset downwards to preserve lower offsets.
 * Untouched byte ranges outside the edited slices remain 100% byte-identical.
 *
 * @param text - Original text from document snapshot or disk
 * @param edits - Array of search/replace edits
 * @param optionsOrPath - File path string or options object for diagnostic messages
 * @returns Result object with modified text or error reason with line hint
 */
export function applyEdits(
  text: string,
  edits: EditItem[],
  optionsOrPath?: string | ApplyEditsOptions
): ApplyEditsResult {
  const path = typeof optionsOrPath === 'string' ? optionsOrPath : optionsOrPath?.path;
  const fileLabel = path ? ` in ${path}` : '';

  if (edits.length === 0) {
    return { ok: true, text };
  }

  if (edits.length > 20) {
    return {
      ok: false,
      reason: `Too many edits: ${edits.length} provided, maximum is 20`,
    };
  }

  interface MatchedEdit {
    editIndex: number;
    start: number;
    end: number;
    matchedText: string;
    newText: string;
  }

  const matchedEdits: MatchedEdit[] = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (!edit.oldText) {
      return {
        ok: false,
        reason: `oldText must not be empty${fileLabel}`,
      };
    }

    const pattern = escapeRegexForEol(edit.oldText);
    const regex = new RegExp(pattern, 'g');
    const matches: Array<{ start: number; end: number; matchedText: string }> = [];

    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        matchedText: match[0],
      });
      if (match[0].length === 0) {
        regex.lastIndex++;
      }
    }

    if (matches.length === 0) {
      // Find line range hint for the user / model to retry
      const firstNonEmptyLine = edit.oldText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);

      const textLines = text.split(/\r?\n/);
      let hint: { startLine: number; endLine: number } = {
        startLine: 1,
        endLine: Math.min(20, textLines.length || 1),
      };

      if (firstNonEmptyLine) {
        const foundIdx = textLines.findIndex((l) => l.includes(firstNonEmptyLine));
        if (foundIdx !== -1) {
          hint = {
            startLine: Math.max(1, foundIdx - 2),
            endLine: Math.min(textLines.length, foundIdx + 10),
          };
        }
      }

      return {
        ok: false,
        reason: `oldText matched 0 times${fileLabel}; re-read lines ${hint.startLine}–${hint.endLine} and retry with more context`,
        hint,
      };
    }

    if (matches.length > 1) {
      return {
        ok: false,
        reason: `oldText matched ${matches.length} times${fileLabel}; ambiguous match`,
      };
    }

    matchedEdits.push({
      editIndex: i,
      start: matches[0].start,
      end: matches[0].end,
      matchedText: matches[0].matchedText,
      newText: edit.newText,
    });
  }

  // Check for overlapping edits
  const sortedByStart = [...matchedEdits].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sortedByStart.length - 1; i++) {
    if (sortedByStart[i].end > sortedByStart[i + 1].start) {
      return {
        ok: false,
        reason: `Edits overlap${fileLabel}`,
      };
    }
  }

  // Splice from highest offset to lowest so earlier offsets remain valid
  const sortedDescending = [...matchedEdits].sort((a, b) => b.start - a.start);
  let result = text;
  const fileDominantlyCrlf = isDominantlyCrlf(text);

  for (const item of sortedDescending) {
    let formattedNewText = item.newText;

    if (item.matchedText.includes('\r\n')) {
      // Matched region used CRLF: standardize replacement newlines to CRLF
      formattedNewText = formattedNewText.replace(/\r?\n/g, '\r\n');
    } else if (item.matchedText.includes('\n')) {
      // Matched region used LF: standardize replacement newlines to LF
      formattedNewText = formattedNewText.replace(/\r\n/g, '\n');
    } else if (formattedNewText.includes('\n')) {
      // Single line replacement: use surrounding or file dominant style
      if (fileDominantlyCrlf) {
        formattedNewText = formattedNewText.replace(/\r?\n/g, '\r\n');
      } else {
        formattedNewText = formattedNewText.replace(/\r\n/g, '\n');
      }
    }

    result = result.slice(0, item.start) + formattedNewText + result.slice(item.end);
  }

  return { ok: true, text: result };
}
