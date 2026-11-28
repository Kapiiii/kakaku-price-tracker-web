import { dateLabel, yen } from "./core.js?v=performance";
import { escapeHTML as esc } from "./view-helpers.js?v=performance";

export function chart(records, label = "保存時点ごとの総額推移") {
  const rows = records;
  if (!rows.some((r) => r.value !== null || r.filteredValue !== null)) {
    return '<div class="empty"><p>価格を取得すると推移が表示されます。</p></div>';
  }
  const width = 900,
    height = 250,
    left = 76,
    right = 30,
    top = 25,
    bottom = 45,
    values = rows.flatMap((r) => [r.value, r.filteredValue].filter((v) => v !== null));
  const min = Math.min(...values),
    max = Math.max(...values),
    padding = Math.max((max - min) * .2, max * .015, 100),
    low = Math.max(0, min - padding),
    high = max + padding;
  const times = rows.map((r) => +new Date(r.date)), start = Math.min(...times), end = Math.max(...times);
  const dates = rows.map((r) => esc(dateLabel(r.date)));
  const x = (i) =>
      left +
      (start === end
        ? (width - left - right) / 2
        : (times[i] - start) / (end - start) * (width - left - right)),
    y = (v) => top + (high - v) / (high - low) * (height - top - bottom);
  let svg = `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${
    esc(label)
  }。詳細値は下の履歴表に表示しています。">`;
  for (let n = 0; n < 4; n++) {
    const v = low + (high - low) * n / 3;
    svg += `<line class="axis" x1="${left}" x2="${width - right}" y1="${y(v)}" y2="${y(v)}"/><text x="${
      left - 12
    }" y="${y(v) + 4}" text-anchor="end">${esc(yen(Math.round(v)))}</text>`;
  }
  for (
    const [key, segment, summaryKey, marker, seriesLabel] of [
      ["value", "rawSegment", "raw", "circle", "最安価格"],
      ["filteredValue", "filteredSegment", "filtered", "rect", "ショップ除外後"],
    ]
  ) {
    const series = `series-${summaryKey}`;
    let previous = null;
    rows.forEach((r, i) => {
      if (r[key] === null) {
        previous = null;
        return;
      }
      const xx = x(i), yy = y(r[key]);
      if (previous && r[segment] === previous.r[segment]) {
        svg += `<path class="chart-line ${series}" ${
          r.estimate || r[summaryKey].total === null ? 'stroke-dasharray="5 5"' : ""
        } d="M${previous.x},${previous.y} L${xx},${yy}"/>`;
      }
      const position = marker === "circle"
        ? `cx="${xx}" cy="${yy}" r="4.5"`
        : `x="${xx - 3}" y="${yy - 3}" width="6" height="6" rx="1"`;
      svg += `<${marker} class="chart-point ${series}${
        r.estimate ? " estimate" : ""
      }" ${position}><title>${seriesLabel} · ${dates[i]} · ${esc(yen(r[key]))}${
        r[summaryKey].total === null ? "（小計）" : ""
      }${r.note ? `（${esc(r.note)}）` : ""}</title></${marker}>`;
      previous = { r, x: xx, y: yy };
    });
  }
  const ticks = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])];
  for (const i of ticks) {
    svg += `<text x="${x(i)}" y="${height - 14}" text-anchor="middle">${dates[i].slice(0, 10)}</text>`;
  }
  const equalPrices = rows.every((r) => r.value === r.filteredValue);
  return `<div class="chart-wrap">${svg}</svg></div>${
    equalPrices
      ? '<p class="chart-note">この表示範囲では、最安価格とショップ除外後の価格が同じです。</p>'
      : ""
  }`;
}
