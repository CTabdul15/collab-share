export interface TextReplace {
  /** Start offset in the old text (UTF-16 code units). */
  start: number;
  /** End offset (exclusive) in the old text. */
  end: number;
  /** Replacement text. */
  text: string;
}

/**
 * Smallest single replacement turning `a` into `b`, found by trimming the common prefix and suffix.
 * Never splits a CRLF pair or a surrogate pair, so offsets always map to valid editor positions.
 */
export function diff(a: string, b: string): TextReplace {
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
  while (prefix > 0 && (isSplitPoint(a, prefix) || isSplitPoint(b, prefix))) prefix--;

  let suffix = 0;
  const maxSuffix = max - prefix;
  while (
    suffix < maxSuffix &&
    a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)
  ) {
    suffix++;
  }
  while (suffix > 0 && (isSplitPoint(a, a.length - suffix) || isSplitPoint(b, b.length - suffix))) suffix--;

  return { start: prefix, end: a.length - suffix, text: b.slice(prefix, b.length - suffix) };
}

/** True if cutting `s` at index `i` would split "\r\n" or a surrogate pair. */
function isSplitPoint(s: string, i: number): boolean {
  if (i <= 0 || i >= s.length) return false;
  const before = s.charCodeAt(i - 1);
  const after = s.charCodeAt(i);
  if (before === 13 && after === 10) return true;
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** Applies a replacement to a string (used by tests and for sanity checks). */
export function applyReplace(s: string, r: TextReplace): string {
  return s.slice(0, r.start) + r.text + s.slice(r.end);
}
