/** Read the source rather than rendered HTML: Markdown and whitespace stay intact. */
export function taskPrompt(raw: string): string | null {
  const match = raw.match(/^(`{3,}|~{3,})mcc-task[^\r\n]*\r?\n([\s\S]*?)\r?\n[ \t]*(`{3,}|~{3,})[ \t]*$/);
  if (!match || match[1][0] !== match[3][0] || match[3].length < match[1].length || !match[2].trim()) return null;
  return match[2];
}
