// Text copied from a terminal → markdown that reads well in a proportional font.
// Terminal text is hard-wrapped at the pane width, indented by the agent's UI,
// and its tables are drawn with box characters. Best effort, never lossy:
// anything that doesn't look like prose is kept line for line.

const TABLE_TOP = /^\s*[┌┏╔]/;
const TABLE_ROW = /^\s*[│┃║].*[│┃║]\s*$/;
const TABLE_RULE = /^\s*[├┣╠┝┠]/;
const TABLE_END = /^\s*[└┗╚]/;
const FRAME_ONLY = /^[\s╭╮╰╯─━═┄┈│┃]+$/;
const FRAME_SIDES = /^\s*│ ?(.*?) ?│?\s*$/;
const MARKER = /^(\s*)(?:⏺|●|⎿|✻|✳|∴)\s?/;
const BULLET = /^(\s*)[•◦▪‣∙·]\s+/;
const BLOCK_START = /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|```|~~~|\||<)/;
const CODEISH = /[{};=<>]|^\s*(?:\$|#!|\/\/|import |export |const |let |def |fn |pub |return\b)/;

function cells(line) {
  return line.trim().replace(/^[│┃║]|[│┃║]$/g, "").split(/[│┃║]/).map((c) => c.trim().replace(/\|/g, "\\|"));
}

/** Box-drawn tables (┌─┬─┐ │ a │ b │ ├─┼─┤ └─┴─┘) → pipe tables. */
function tables(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!TABLE_TOP.test(lines[i]) && !TABLE_ROW.test(lines[i])) { out.push(lines[i]); continue; }
    // Collect the block: segments of row lines between ├ rules.
    const segs = [[]];
    let rules = 0;
    let j = i;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (TABLE_TOP.test(l)) continue;
      if (TABLE_END.test(l)) { j++; break; }
      if (TABLE_RULE.test(l)) { rules++; segs.push([]); continue; }
      if (!TABLE_ROW.test(l)) break;
      segs[segs.length - 1].push(cells(l));
    }
    // A rule after every row: a segment's lines are one wrapped row. Otherwise one line, one row.
    const rows = [];
    for (const seg of segs) {
      if (!seg.length) continue;
      if (rules >= 2 && seg.every((c) => c.length === seg[0].length)) rows.push(seg[0].map((_, k) => seg.map((c) => c[k]).filter(Boolean).join(" ")));
      else rows.push(...seg);
    }
    if (rows.length < 1 || rows[0].length < 2) { out.push(lines[i]); continue; }
    const n = rows[0].length;
    out.push("");
    out.push(`| ${rows[0].join(" | ")} |`);
    out.push(`|${" --- |".repeat(n)}`);
    for (const r of rows.slice(1)) out.push(`| ${r.concat(Array(Math.max(0, n - r.length)).fill("")).slice(0, n).join(" | ")} |`);
    out.push("");
    i = j - 1;
  }
  return out;
}

const indentOf = (l) => l.match(/^\s*/)[0].length;

/**
 * @param {string} text   terminal text
 * @param {{reflow?: boolean}} opts  reflow: join hard-wrapped lines into paragraphs
 */
export function terminalToMarkdown(text, opts = {}) {
  const reflow = opts.reflow !== false;
  let lines = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n").map((l) => l.replace(/\s+$/, ""));

  lines = tables(lines);

  // Agent UI: frames around input boxes, ⏺ message markers, • bullets.
  lines = lines
    .filter((l) => !l.trim() || !FRAME_ONLY.test(l))
    .map((l) => {
      if (/^\s*│/.test(l) && !/^\s*\|/.test(l)) l = l.replace(FRAME_SIDES, "$1");
      if (MARKER.test(l)) l = l.replace(MARKER, (m, sp) => sp + " ".repeat(m.length - sp.length));
      return l.replace(BULLET, "$1- ");
    });

  // Dedent by the smallest indent of a non-empty line.
  const min = Math.min(...lines.filter((l) => l.trim()).map(indentOf), Infinity);
  if (Number.isFinite(min) && min > 0) lines = lines.map((l) => l.slice(Math.min(min, indentOf(l))));

  if (!reflow) return lines.map((l) => (l.trim() ? `${l}  ` : l)).join("\n").trim();

  // The wrap width: the longest prose lines tell us where the terminal broke them.
  const lens = lines.filter((l) => l.trim() && !/^\s*\|/.test(l)).map((l) => l.length).sort((a, b) => b - a);
  const width = lens.length ? lens[Math.min(lens.length - 1, Math.floor(lens.length * 0.1))] : 80;
  const full = (l) => l.length >= width - 14;

  const out = [];
  let fence = false;
  let prev = null; // the previous output line we may join onto, or null
  for (const raw of lines) {
    const l = raw;
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; out.push(l); prev = null; continue; }
    if (fence) { out.push(l); continue; }
    if (!l.trim()) { out.push(""); prev = null; continue; }
    if (/^\s*\|/.test(l)) { out.push(l); prev = null; continue; }
    const ind = indentOf(l);
    const code = ind >= 4 && (prev == null || !/^\s*(?:[-*+]|\d+[.)])\s/.test(out[out.length - 1])) && CODEISH.test(l);
    if (code) {
      if (prev != null) out.push("");
      out.push(l);
      prev = null;
      continue;
    }
    if (prev != null && !BLOCK_START.test(l)) {
      const p = out[out.length - 1];
      if (full(p)) { out[out.length - 1] = `${p} ${l.trim()}`; continue; }
      out[out.length - 1] = `${p}  `; // short line: the author broke it here
    }
    out.push(l);
    prev = l;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
