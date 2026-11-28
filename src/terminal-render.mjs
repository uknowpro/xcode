import { answerRows } from './answer-view.mjs';
import { terminalClip } from './terminal.mjs';

export function answerViewport(pager, text, width, height, move = 0) {
  const { rows, outline } = answerRows(text, width, pager.numbered);
  pager.outline = outline;
  pager.rowCount = rows.length;
  const last = Math.max(0, rows.length - height);
  if (pager.target !== undefined) {
    pager.offset = Math.max(0, rows.findIndex(row => row.source >= pager.target));
    pager.target = undefined;
  }
  pager.offset = pager.follow ? last : Math.max(0, Math.min(last, pager.offset + move));
  return [
    terminalClip((pager.live ? 'Live response' : 'Response · turn ' + pager.turn) +
      (pager.live && !pager.follow ? ' · ' + Math.max(0, rows.length - (pager.seen ?? rows.length)) + ' new lines' : '') +
      (pager.hits ? ' · match ' + (pager.hit + 1) + '/' + pager.hits.length : ''), width),
    ...rows.slice(pager.offset, pager.offset + height).map(row => row.text),
    terminalClip('↑/↓ Scroll · Tab Outline · n/p Match · l Numbers · End Follow · Esc Close', width),
  ];
}

export function sessionViewport(pager, selectedId, width, height) {
  pager.offset = Math.max(0, Math.min(pager.offset, pager.focus));
  if (pager.focus >= pager.offset + height) pager.offset = pager.focus - height + 1;
  return [
    terminalClip('Sessions · ' + pager.rows.length + (pager.query ? ' · ' + pager.query : '') +
      (pager.unreadable ? ' · ' + pager.unreadable + ' unreadable' : ''), width),
    ...pager.rows.slice(pager.offset, pager.offset + height).map((row, index) => terminalClip(
      (index + pager.offset === pager.focus ? '› ' : '  ') + (row.id === selectedId ? '* ' : '  ') + row.text, width)),
    terminalClip('↑/↓ Select session · Enter Switch · Esc Close', width),
  ];
}
