import { wrapTerminal } from './terminal.mjs';

export function answerRows(text, width, numbered = false) {
  const rows = [], outline = [];
  const add = (value, source) => {
    for (const line of wrapTerminal(value, width)) rows.push({ text: line, source });
  };
  let fence, code = 0;
  for (const [source, line] of text.split(/\r?\n/).entries()) {
    const token = /^\s*(~~~+|```+)(.*)$/.exec(line);
    if (token && !fence) {
      fence = token[1];
      const language = token[2].trim().slice(0, 40) || 'text';
      const title = 'Code · ' + language;
      outline.push({ title, row: rows.length });
      code = 0;
      add(title, source);
    } else if (token && token[1][0] === fence?.[0] && token[1].length >= fence.length && !token[2].trim()) {
      fence = undefined;
    } else if (fence) {
      code++;
      add((numbered ? String(code).padStart(4) + ' │ ' : '  ') + line, source);
    } else {
      const heading = /^\s*#{1,6}\s+(.+)$/.exec(line);
      if (heading) {
        outline.push({ title: heading[1], row: rows.length });
        add('◆ ' + heading[1], source);
      } else if (/^\s*\|.*\|\s*$/.test(line)) {
        const cells = line.trim().slice(1, -1).split('|').map(cell => cell.trim());
        if (!cells.every(cell => /^:?-{2,}:?$/.test(cell))) add(cells.join(' │ '), source);
      } else {
        add(line.replace(/^\s*>\s*/, '│ ').replace(/^(\s*)[-*]\s+\[([ xX])\]\s+/, (_, spaces, mark) =>
          spaces + (mark.trim() ? '[✓] ' : '[ ] ')).replace(/^(\s*)[-*]\s+/, '$1• '), source);
      }
    }
  }
  return { rows, outline };
}

export function matchingAnswers(turns, term) {
  const needle = term.toLowerCase();
  const results = [];
  if (!needle) return results;
  for (let turn = turns.length - 1; turn >= 0 && results.length < 300; turn--) {
    const answer = turns[turn]?.answer;
    if (!answer) continue;
    for (const [line, text] of answer.split(/\r?\n/).entries()) {
      if (text.toLowerCase().includes(needle)) results.push({ turn, line, text });
      if (results.length >= 300) break;
    }
  }
  return results;
}
