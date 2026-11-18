/** Render exported writing directives as Markdown blockquotes, preserving code samples. */
export function writingBlocks(text: string): string {
  let writing = false;
  let fence: { marker: string; length: number } | null = null;
  return text.split('\n').map((line) => {
    const codeFence = line.match(/^\s*(`{3,}|~{3,})/);
    if (codeFence) {
      const marker = codeFence[1][0];
      if (!fence) fence = { marker, length: codeFence[1].length };
      else if (marker === fence.marker && codeFence[1].length >= fence.length && /^\s*(?:`+|~+)\s*$/.test(line)) fence = null;
      return writing ? `> ${line}` : line;
    }
    if (!fence) {
      const opening = line.match(/^\s*:::writing\{[^}\n]*\}\s*(.*)$/);
      if (opening) {
        writing = true;
        const content = opening[1].replace(/\s*:::\s*$/, () => { writing = false; return ''; });
        return `\n> ${content}`;
      }
      if (writing && /^\s*:::\s*$/.test(line)) {
        writing = false;
        return '\n';
      }
    }
    return writing ? `> ${line}` : line;
  }).join('\n');
}
