export function chooseGridLayout(participantCount, width, height) {
  const count = Math.max(1, Number(participantCount) || 1);
  const safeWidth = Math.max(1, Number(width) || 1);
  const safeHeight = Math.max(1, Number(height) || 1);
  const maxColumns = Math.min(count, safeWidth < 520 ? 2 : safeWidth < 860 ? 3 : 5);
  let best = { columns: 1, rows: count, score: 0 };

  for (let columns = 1; columns <= maxColumns; columns += 1) {
    const rows = Math.ceil(count / columns);
    const tileWidth = safeWidth / columns;
    const tileHeight = safeHeight / rows;
    const aspect = tileWidth / tileHeight;
    const shapePenalty = Math.abs(Math.log(aspect / (16 / 9)));
    const score = Math.min(tileWidth, tileHeight * (16 / 9)) - shapePenalty * 80;
    if (score > best.score) best = { columns, rows, score };
  }
  return { columns: best.columns, rows: best.rows };
}

export function nextLayout(current, requested) {
  return ['grid', 'speaker', 'focus'].includes(requested) ? requested : current;
}
