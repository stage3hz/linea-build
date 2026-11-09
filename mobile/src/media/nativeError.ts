// Expo wraps native module failures as «UnexpectedException: <text> [ERR_CODE] (at File.swift:126)».
// The text is already written for people; the class name, code and source location are not.
export function nativeErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const text = raw
    .replace(/^\s*[A-Za-z][\w.]*(?:Exception|Error)\s*:\s*/, '')
    .replace(/\s*\(at [^()]*\)\s*$/, '')
    .replace(/\s*\[[A-Z][A-Z0-9_]*\]\s*$/, '')
    .trim();
  return text || fallback;
}
