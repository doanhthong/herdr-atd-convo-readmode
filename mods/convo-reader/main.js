// Read Mode: an agent's conversation, or text copied from a terminal, as a
// readable document (proportional type, rendered markdown, a centered column).
//
// Open: cmd-shift-m (keys.json: "mod.open:convo-reader"), or the palette entries.
// Conversation: Claude Code's transcript for the terminal you were in (extract.py);
// other programs fall back to the terminal's text. Clipboard: the clipboard's text,
// cleaned of terminal wrapping (clean.js).
//
// Docked: the "readmode" block in the right sidebar (cmd-alt-m toggles it) follows the
// focused terminal and re-reads when its agent finishes a turn.
//
// Keys: 1 conversation · 2 clipboard · o contents · t tools · w reflow · r reload
//       c copy markdown · = / - text size · esc close

import { View, div, list } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, TextView, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { exec, appHome, theme, fonts, props, closeOverlay, focused, agents, panes, layout, run, shared, setShared, notify, nextCommand } from "herdr";
import { terminalToMarkdown } from "./clean.js";

const K = (k) => `convo-reader.${k}`;
const MODES = ["conversation", "clipboard"];
const SIZES = [13, 14, 15, 16, 17, 18, 20, 22];
// Reading measure: ~66–72 characters a line (Bringhurst / Butterick: 45–75). For a
// proportional sans, a character averages ~0.5em, so the column is ~36em wide.
const MEASURE_EM = 36;
const LEADING = 1.6; // 120–145% is print's range; screens and dark backgrounds want a bit more
const END_PAD = 48;
const MEASURE_QUIET = 600; // ms a message's height must hold still before it's trusted
const BOTTOM_HOLD = 1500; // ms after opening at the end during which late growth re-pins it
const TOC_W = 240;
// Docked: the layout block in the right sidebar (layouts/atd.json, id "readmode").
const DOCK_ID = "readmode";
const FOLLOW_MS = 700; // how often a docked copy checks which terminal to read
const WIDE_HEADER = 900; // px a docked copy needs for the one-row header

// A short fingerprint of a message, so a re-read that changes it is measured again.
function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const f = findNode(c, id); if (f) return f; }
  return null;
}
const SERIFS = ["New York", "Charter", "Iowan Old Style", "Georgia"];
// Herdr's UI font (Geist) ships as a single Regular face and bold isn't synthesized, so
// markdown **bold** would render regular. The sans body uses a system sans with real weights.
const SANS = ["SF Pro Text", "SF Pro", "Inter", "Helvetica Neue"];

// Mix two #rrggbb colors; anything else falls back to `a`.
function mix(a, b, t) {
  const p = (c) => /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.test(c ?? "") ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : null;
  const x = p(a), y = p(b);
  if (!x || !y) return a;
  return "#" + x.map((v, i) => Math.round(v * (1 - t) + y[i] * t).toString(16).padStart(2, "0")).join("");
}
function isDark(c) {
  const m = /^#([0-9a-f]{6})/i.exec(c ?? "");
  if (!m) return true;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

// A contents line for one of your messages: its first line of text, markdown stripped.
function tocLabel(parts) {
  for (const p of parts) {
    if (p.kind === "command") return p.text;
    if (p.kind !== "text") continue;
    const line = p.text.split("\n").map((l) => l.trim()).find((l) => l && !/^```/.test(l));
    if (!line) continue;
    const clean = line.replace(/^(#+|[-*+>]|\d+[.)])\s+/, "").replace(/[`*_~]|\[([^\]]*)\]\([^)]*\)/g, (m, a) => a ?? "").trim();
    return clean.length > 120 ? clean.slice(0, 120) + "…" : clean;
  }
  return null;
}

export default class ReadMode extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    // A layout block (the right sidebar) rather than a dialog: it stays open beside the
    // terminals, follows the one you focus, and Esc hides the block instead of closing.
    this.docked = !props()?.overlay && !!props()?.docked;
    this.mode = MODES.includes(shared(K("mode"))) ? shared(K("mode")) : "conversation";
    this.size = SIZES.includes(shared(K("size"))) ? shared(K("size")) : 16;
    this.tools = shared(K("tools")) !== false;
    this.reflow = shared(K("reflow")) !== false;
    this.serif = shared(K("serif")) === true;
    this.toc = this.docked ? shared(K("dock.toc")) === true : shared(K("toc")) !== false;
    const have = (() => { try { return new Set(fonts()); } catch { return new Set(); } })();
    this.serifFont = SERIFS.find((f) => have.has(f)) ?? null;
    this.sansFont = SANS.find((f) => have.has(f)) ?? null;
    // The conversation opens at its end: each message is measured (hidden), then a virtual
    // list of those heights is scrolled to the bottom. A message's first height can be
    // short (long markdown and tables finish laying out a frame or more later), so the
    // hidden copy stays mounted until its height has held still for MEASURE_QUIET ms.
    this.scroll = VirtualListScrollHandle.new();
    this.heights = new Map(); // measureKey → px
    this.lastH = new Map(); // item key → its last measured px, a stand-in while a changed message is measured
    this.keepShown = false; // a quiet re-read: keep the list up (no cover) while measuring
    this.measuredAt = new Map(); // measureKey → when its height last changed
    this.measureUntil = 0; // when the last hidden copy can go
    this.bottomAt = 0; // when the list was last sent to the bottom
    this.bodyW = 0;
    this.wantBottom = true;
    // Where to put the list once it's laid out: { bottom: true } or { item: i }. A scroll
    // request made before the list has been laid out at least once is dropped (the handle
    // doesn't know the item count yet), so the list is drawn under a cover and the request
    // is repeated on the next ticks, then the cover is lifted.
    this.pending = null;
    this.settle = 0;
    this.visEnd = 0; // one past the last item the virtual list drew
    this.visStart = 0; // first item the virtual list drew; the contents highlights its turn
    this.tocAt = -1;
    this.target = this.pickTerminal();
    this.convo = { state: "loading" };
    this.clip = "";
    this.items = [];
    this.rebuild();
    this.load(cx);
    this.readClip(cx);
    if (!this.docked) cx.timer.after(50, () => this.handle.focus());
    if (this.docked) {
      this.agentStatus = this.statusOf(this.target);
      cx.timer.every(FOLLOW_MS, (cx) => this.follow(cx));
    }
    cx.timer.every(30, (cx) => {
      if (this.settle > 0) {
        this.applyPending();
        if (--this.settle === 0) this.pending = null;
        cx.notify();
      } else if (this.measureUntil && Date.now() > this.measureUntil) {
        this.measureUntil = 0; // heights have settled: drop the hidden copies
        cx.notify();
      } else if (this.mode === "conversation" && this.toc && this.visStart !== this.tocAt) {
        cx.notify();
      }
    });
    // keys.json "convo-reader.clipboard" / "convo-reader.conversation" while it's open.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (MODES.includes(c)) this.setMode(c, cx);
        else if (c === "reload") this.reload(cx);
        else if (c === "focus") this.handle.focus();
      }
    });
  }

  // The terminal you were reading: the focused one, else the agent its pane or tab shows.
  pickTerminal() {
    const f = focused();
    if (f?.terminal) return f.terminal;
    if (f?.agent) return f.agent;
    const inTab = agents().find((a) => a.tab === f?.tab) ?? panes().find((p) => p.tab === f?.tab && p.terminal);
    return inTab?.address ?? inTab?.terminal ?? agents().find((a) => a.focused)?.address ?? null;
  }

  statusOf(addr) {
    return agents().find((a) => a.address === addr)?.status ?? null;
  }

  shown() {
    const n = findNode(layout(), DOCK_ID);
    return !!n && !n.hidden;
  }

  // Docked: read whichever terminal has focus now, and re-read when its agent finishes a turn.
  // Reads happen in either tab, so the conversation is current when you switch back to it.
  follow(cx) {
    if (!this.shown()) { this.wasHidden = true; return; }
    // Only a focused terminal or agent retargets: while the block itself has focus, keep reading
    // the same terminal (pickTerminal's tab fallback could pick a different agent in the tab).
    const f = focused();
    const next = f?.terminal ?? f?.agent ?? null;
    const status = this.statusOf(next ?? this.target);
    const back = this.wasHidden;
    this.wasHidden = false;
    if (next && next !== this.target) {
      this.target = next;
      this.agentStatus = status;
      this.resetView();
      this.load(cx);
      cx.notify();
      return;
    }
    const finished = this.agentStatus === "working" && status !== "working";
    this.agentStatus = status;
    if (finished || back) this.load(cx, { quiet: true });
  }

  resetView() {
    this.heights.clear();
    this.measuredAt.clear();
    this.lastH.clear();
    this.wantBottom = true;
    this.keepShown = false;
    this.pending = null;
    this.settle = 0;
  }

  load(cx, { quiet = false } = {}) {
    if (!this.target) { this.convo = { state: "error", text: "No terminal is focused." }; this.rebuild(); return; }
    // A quiet re-read keeps the current text on screen until the new one is ready.
    quiet = quiet && this.convo.state === "ready";
    if (!quiet) {
      this.keepShown = false;
      this.convo = { state: "loading" };
      this.rebuild();
    }
    const target = this.target;
    const seq = (this.loadSeq = (this.loadSeq ?? 0) + 1);
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", ["-I", `${appHome()}/mods/convo-reader/extract.py`, target]);
        if (seq !== this.loadSeq) return; // a newer read (or focus moving on) superseded this one
        const d = JSON.parse(r.stdout || "null");
        if (!d) throw new Error(r.stderr.trim() || "no output");
        const next = d.kind === "error" ? { state: "error", text: d.text } : { state: "ready", ...d };
        if (quiet && JSON.stringify(next) === JSON.stringify(this.convo)) return;
        this.convo = next;
      } catch (e) {
        if (seq !== this.loadSeq) return;
        if (quiet) return; // a failed background re-read keeps the conversation on screen
        this.convo = { state: "error", text: String(e?.message ?? e) };
      }
      // Only once the list has settled where it was sent (no scroll still pending): otherwise
      // this would drop the opening cover and scroll.
      if (quiet && this.mode === "conversation" && this.convo.state === "ready" && !this.wantBottom && !this.pending) {
        // Stay where the reader is: follow the new turn only if they were already at the end
        // (the end pad, item items.length, is drawn; range.end is exclusive).
        const atEnd = this.visEnd > this.items.length;
        this.keepShown = true; // no cover while the changed messages are measured
        if (atEnd) this.wantBottom = "quiet";
        else { this.pending = { item: this.visStart }; this.settle = 0; }
      } else {
        this.wantBottom = true;
      }
      this.rebuild();
      cx.notify();
    });
  }

  async close() {
    try { this.scroll.release(); } catch {}
  }

  // Mods aren't granted the clipboard: ask the system's tools.
  readClip(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("/usr/bin/env", ["LC_ALL=en_US.UTF-8", "LANG=en_US.UTF-8", "pbpaste"]);
        this.clip = r.code === 0 ? r.stdout : "";
      } catch { this.clip = ""; }
      if (this.mode === "clipboard") { this.rebuild(); cx.notify(); }
    });
  }

  agentName() {
    const a = agents().find((x) => x.address === this.target);
    const n = a?.program?.name ?? "Agent";
    return n === "Claude Code" ? "Claude" : n;
  }

  // ---- the document ------------------------------------------------------------

  rebuild() {
    this.tocEntries = [];
    this.items = this.mode === "clipboard" ? this.clipItems() : this.convoItems();
  }

  clipItems() {
    if (!this.clip.trim()) return [{ key: "empty", kind: "empty", text: "The clipboard has no text. Select text in a terminal, copy it, then press r." }];
    return [{ key: "clip", kind: "doc", text: terminalToMarkdown(this.clip, { reflow: this.reflow }) }];
  }

  convoItems() {
    const c = this.convo;
    if (c.state === "loading") return [{ key: "loading", kind: "empty", text: "Reading the conversation…" }];
    if (c.state === "error") return [{ key: "error", kind: "empty", text: c.text }];
    if (c.kind === "screen") return [{ key: "screen", kind: "doc", text: terminalToMarkdown(c.text, { reflow: this.reflow }), note: "Not a Claude Code session: showing the terminal's text." }];
    const out = [];
    c.turns.forEach((t, i) => {
      const parts = [];
      let toolRun = [];
      const flush = () => {
        if (!toolRun.length) return;
        parts.push(this.tools ? { kind: "tools", list: toolRun } : { kind: "toolcount", n: toolRun.length });
        toolRun = [];
      };
      for (const p of t.parts) {
        if (p.kind === "tool") { toolRun.push(p); continue; }
        flush();
        parts.push(p);
      }
      flush();
      if (!this.tools && parts.every((p) => p.kind === "toolcount") && out.length && out[out.length - 1].role === "assistant") {
        // Only tools, hidden: fold into the previous assistant turn's count.
        const prev = out[out.length - 1].parts;
        const last = prev[prev.length - 1];
        if (last?.kind === "toolcount") { last.n += parts[0].n; return; }
      }
      out.push({ key: `turn-${i}`, kind: "turn", role: t.role, parts });
    });
    this.tocEntries = [];
    out.forEach((it, i) => {
      if (it.role !== "user") return;
      const label = tocLabel(it.parts);
      if (label) this.tocEntries.push({ index: i, label });
    });
    if (!out.length) return [{ key: "empty", kind: "empty", text: "This conversation has no messages yet." }];
    this.turnCount = out.length;
    return out;
  }

  markdown() {
    if (this.mode === "clipboard") return this.items[0]?.text ?? "";
    if (this.convo.kind === "screen") return this.items[0]?.text ?? "";
    const name = this.agentName();
    const lines = [];
    if (this.convo.title) lines.push(`# ${this.convo.title}`, "");
    for (const it of this.items) {
      if (it.kind !== "turn") continue;
      lines.push(`## ${it.role === "user" ? "You" : name}`, "");
      for (const p of it.parts) {
        if (p.kind === "text") lines.push(p.text, "");
        else if (p.kind === "command") lines.push(`\`${p.text}\``, "");
        else if (p.kind === "note") lines.push(`> ${p.text.split("\n").join("\n> ")}`, "");
        else if (p.kind === "tools") lines.push(...p.list.map((x) => `- *${x.name}* ${x.text}`), "");
      }
    }
    return lines.join("\n").trim() + "\n";
  }

  // ---- actions -------------------------------------------------------------------

  setMode(mode, cx) {
    if (mode === "clipboard") this.readClip(cx);
    this.mode = mode;
    if (mode === "conversation") this.wantBottom = true;
    this.keepShown = false; // a different document: measure it under the cover
    setShared(K("mode"), mode);
    this.rebuild();
    cx.notify();
  }

  toggle(key, cx) {
    // Changing the column's width or the items' heights moves things: keep the turn in view.
    if (this.mode === "conversation" && ["toc", "tools", "serif"].includes(key) && !this.wantBottom) this.pending = { item: this.visStart };
    this[key] = !this[key];
    setShared(K(this.docked && key === "toc" ? "dock.toc" : key), this[key]);
    this.rebuild();
    cx.notify();
  }

  resize(step, cx) {
    const i = Math.max(0, Math.min(SIZES.length - 1, SIZES.indexOf(this.size) + step));
    if (this.mode === "conversation" && !this.wantBottom && SIZES[i] !== this.size) this.pending = { item: this.visStart };
    this.size = SIZES[i];
    setShared(K("size"), this.size);
    cx.notify();
  }

  jumpTo(index, cx) {
    this.wantBottom = false;
    this.pending = { item: index };
    this.settle = 2;
    this.applyPending();
    this.visStart = index;
    cx.notify();
  }

  applyPending() {
    const p = this.pending;
    if (!p) return;
    if (p.bottom) this.scroll.scroll_to_bottom();
    else this.scroll.scroll_to_item(Math.min(p.item, this.items.length - 1), "top");
  }

  reload(cx) {
    if (this.mode === "clipboard") this.readClip(cx);
    else this.load(cx);
  }

  copy(cx) {
    const text = this.markdown();
    cx.spawn(async () => {
      try {
        const r = await exec("/usr/bin/env", ["LC_ALL=en_US.UTF-8", "LANG=en_US.UTF-8", "sh", "-c", 'printf %s "$1" | pbcopy', "sh", text]);
        if (r.code !== 0) throw new Error(r.stderr.trim() || "pbcopy failed");
        notify({ title: "Copied as markdown", level: "success", timeout: 2000 });
      } catch (e) {
        notify({ title: "Couldn't copy", body: String(e?.message ?? e), level: "error" });
      }
    });
  }

  close_() {
    if (!this.docked) return closeOverlay(props().overlay);
    run("layout.hide", { id: DOCK_ID });
    if (this.target) run("pane.focus", { terminal: this.target });
  }

  onKey(e, cx) {
    const k = e.key;
    const m = e.modifiers ?? {};
    if (m.platform || m.control || m.alt) return;
    if (k === "escape" || k === "q") return this.close_();
    if (k === "1") return this.setMode("conversation", cx);
    if (k === "2") return this.setMode("clipboard", cx);
    if (k === "tab") return this.setMode(this.mode === "clipboard" ? "conversation" : "clipboard", cx);
    if (k === "o") return this.toggle("toc", cx);
    if (k === "t") return this.toggle("tools", cx);
    if (k === "w") return this.toggle("reflow", cx);
    if (k === "f" && this.serifFont) return this.toggle("serif", cx);
    if (k === "r") return this.reload(cx);
    if (k === "c") return this.copy(cx);
    if (k === "=" || k === "+") return this.resize(1, cx);
    if (k === "-") return this.resize(-1, cx);
  }

  // ---- drawing -----------------------------------------------------------------

  button(t, id, label, onClick, { active = false, title = null } = {}) {
    return div().id(id).px(10).h(28).flex().items_center().rounded(6).text_size(13).cursor_pointer()
      .text_color(active ? t.foreground : t.muted)
      .when(active, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => onClick(cx))
      .child(label);
  }

  header(t) {
    const c = this.convo;
    const title = this.mode === "clipboard" ? "Clipboard" : (c.title ?? this.target ?? "Conversation");
    const sub = this.mode === "clipboard"
      ? `${this.clip.length.toLocaleString()} characters`
      : c.state === "ready" ? (c.kind === "transcript" ? `${this.agentName()} · ${this.turnCount ?? 0} turns · ${this.target}` : `terminal text · ${this.target}`) : this.target ?? "";
    const titles = v_flex().min_w(0).flex_1()
      .child(div().text_size(15).font_semibold().text_color(t.foreground).truncate().child(title))
      .child(div().text_size(12).text_color(t.dim).truncate().child(sub));
    const modes = h_flex().flex_none().gap(2).p(2).rounded(8).bg(t.surface).border(1).border_color(t.border)
      .child(this.button(t, "rm-mode-convo", this.docked ? "Convo" : "Conversation", (cx) => this.setMode("conversation", cx), { active: this.mode === "conversation" }))
      .child(this.button(t, "rm-mode-clip", "Clipboard", (cx) => this.setMode("clipboard", cx), { active: this.mode === "clipboard" }));
    const tools = this.tools_(t, c);
    // Narrow (the sidebar): title above the buttons. Wide (the sidebar dragged wide, the dialog): one row.
    if (this.docked && this.rootW > 0 && this.rootW < WIDE_HEADER) {
      return v_flex().px(12).pt(10).pb(8).gap(8).border_b(1).border_color(t.border).flex_none()
        .child(h_flex().gap(8).items_center().child(titles).child(this.button(t, "rm-close", "✕", () => this.close_())))
        .child(h_flex().gap(4).items_center().flex_wrap().child(modes).child(tools));
    }
    return h_flex().px(16).h(52).gap(12).items_center().justify_between().border_b(1).border_color(t.border).flex_none()
      .child(titles)
      .child(modes)
      .child(tools.child(this.button(t, "rm-close", "✕", () => this.close_())));
  }

  tools_(t, c) {
    return h_flex().gap(2).items_center().flex_wrap()
        .when(this.mode === "conversation" && c.kind !== "screen", (el) => el
          .child(this.button(t, "rm-toc", "Contents", (cx) => this.toggle("toc", cx), { active: this.toc }))
          .child(this.button(t, "rm-tools", "Tools", (cx) => this.toggle("tools", cx), { active: this.tools })))
        .when(this.mode === "clipboard" || c.kind === "screen", (el) => el.child(this.button(t, "rm-reflow", "Reflow", (cx) => this.toggle("reflow", cx), { active: this.reflow })))
        .when(!!this.serifFont, (el) => el.child(this.button(t, "rm-serif", "Serif", (cx) => this.toggle("serif", cx), { active: this.serif })))
        .child(this.button(t, "rm-smaller", "A−", (cx) => this.resize(-1, cx)))
        .child(this.button(t, "rm-bigger", "A+", (cx) => this.resize(1, cx)))
        .child(this.button(t, "rm-copy", "Copy", (cx) => this.copy(cx)))
        .child(this.button(t, "rm-reload", "↻", (cx) => this.reload(cx)));
  }

  // Body text: slightly softened from the theme's foreground on dark backgrounds, where
  // full-contrast strokes bloom (halation) and tire the eye over long reads.
  ink(t) {
    return isDark(t.background) ? mix(t.foreground, t.background, 0.1) : mix(t.foreground, t.background, 0.04);
  }

  font(el) {
    const f = this.serif && this.serifFont ? this.serifFont : this.sansFont;
    return f ? el.font_family(f) : el;
  }

  md(id, text, t) {
    return this.font(TextView.markdown(id, text).selectable(true).w_full().text_size(this.size)
      .line_height(`${Math.round(this.size * LEADING)}px`).text_color(this.ink(t)));
  }

  // Sentence-case speaker names: all-caps needs letter-spacing, which text here can't take.
  label(t, text, color) {
    return div().text_size(Math.max(12, this.size - 3)).font_semibold().text_color(color).child(text);
  }

  part(t, p, id) {
    switch (p.kind) {
      case "text": return this.md(id, p.text, t);
      case "command": return div().px(8).py(2).rounded(5).bg(t.surface).border(1).border_color(t.border).text_size(Math.max(12, this.size - 2)).text_color(t.accent).child(p.text);
      case "note": return div().text_size(Math.max(12, this.size - 3)).line_height(`${Math.round(Math.max(12, this.size - 3) * 1.5)}px`).text_color(t.muted).italic().child(p.text.length > 600 ? p.text.slice(0, 600) + "…" : p.text);
      case "toolcount": return div().text_size(Math.max(12, this.size - 4)).text_color(t.dim).child(`· ${p.n} tool call${p.n === 1 ? "" : "s"}`);
      case "tools": return v_flex().gap(3).pl(10).border_l_2().border_color(t.border)
        .children(p.list.map((x) => h_flex().gap(8).text_size(Math.max(12, this.size - 3)).min_w(0)
          .child(div().flex_none().font_semibold().text_color(x.error ? t.blocked : t.dim).child(x.name))
          .child(div().min_w(0).flex_1().truncate().text_color(t.muted).child(x.text || ""))));
      default: return div();
    }
  }

  item(t, it) {
    const s = this.size;
    const column = (el) => h_flex().w_full().justify_center().px(this.docked ? 18 : 32).child(v_flex().w_full().max_w(Math.round(s * MEASURE_EM)).child(el));
    if (it.kind === "empty") return column(div().pt(48).text_size(14).text_color(t.muted).child(it.text));
    if (it.kind === "doc") return column(v_flex().pt(Math.round(s * 2)).pb(Math.round(s)).gap(Math.round(s * 0.75))
      .when(!!it.note, (el) => el.child(div().text_size(12).text_color(t.dim).child(it.note)))
      .child(this.md(`rm-${it.key}`, it.text || " ", t)));
    const user = it.role === "user";
    // Proximity: a speaker's name sits close to their message (0.4em), turns sit far apart
    // (~2em), and blocks inside a turn get about a paragraph's gap (0.75em).
    const body = v_flex().gap(Math.round(s * 0.75)).children(it.parts.map((p, i) => this.part(t, p, `rm-${it.key}-${i}`)));
    return column(v_flex().pt(Math.round(s * 2)).gap(Math.round(s * 0.4))
      .child(this.label(t, user ? "You" : this.agentName(), user ? t.accent : t.muted))
      .child(user
        ? v_flex().px(Math.round(s * 1.1)).py(Math.round(s * 0.8)).rounded(10).bg(t.surface).border(1).border_color(t.border).child(body)
        : body));
  }

  render(_cx) {
    const t = theme();
    const items = this.items;
    return v_flex().id("rm-root").size_full().bg(t.background).text_color(t.foreground)
      .on_size_change((s, cx) => {
        if (Math.round(s.width) === Math.round(this.rootW ?? 0)) return;
        this.rootW = s.width;
        cx.notify();
      })
      .when(this.docked, (el) => el.rounded(10).border(1).border_color(t.border).overflow_hidden()
        .on_mouse_down("left", () => this.handle.focus()))
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(this.header(t))
      .child(this.mode === "conversation" ? this.convoBody(t, items) : v_flex().relative().flex_1().min_h(0)
        .child(list("rm-list", items.length + 1, (i) => (i < items.length ? items[i].key : "rm-end"),
          (i) => (i < items.length ? this.item(t, items[i]) : div().h(END_PAD)))
          .size_full())
        .child(Scrollbar.vertical("rm-list").absolute().inset_0()));
  }

  // What a height depends on: the item, the column width, the text size and the tools view.
  measureKey(it) {
    it.sig ??= hash(JSON.stringify(it.parts ?? it.text ?? ""));
    return `${it.key}-${it.sig}-${Math.round(this.bodyW)}-${this.size}-${this.tools ? 1 : 0}-${this.serif ? 1 : 0}`;
  }

  convoBody(t, items) {
    const showToc = this.toc && this.tocEntries.length > 0;
    return h_flex().flex_1().min_h(0).w_full()
      .when(showToc, (el) => el.child(this.tocPanel(t)))
      .child(this.convoList(t, items));
  }

  // The contents: one line per message of yours, the one on screen highlighted.
  tocPanel(t) {
    const e = this.tocEntries;
    let cur = -1;
    for (let i = 0; i < e.length; i++) if (e[i].index <= this.visStart) cur = i;
    this.tocAt = this.visStart;
    return v_flex().w(TOC_W).flex_none().h_full().relative().border_r(1).border_color(t.border).bg(t.surface)
      .child(div().px(16).pt(14).pb(8).flex_none().text_size(12).font_semibold().text_color(t.dim).child(`Contents · ${e.length}`))
      .child(v_flex().relative().flex_1().min_h(0)
        .child(v_flex().id("rm-toc").size_full().overflow_y_scroll().px(8).pb(16).gap(1)
          .children(e.map((x, i) => div().id(`rm-toc-${x.index}`).px(8).py(5).rounded(6).cursor_pointer()
            .text_size(13).line_height("18px").truncate()
            .text_color(i === cur ? t.foreground : t.muted)
            .when(i === cur, (el) => el.bg(t.selected))
            .hover((st) => st.bg(t.hover).text_color(t.foreground))
            .on_click((_ev, cx) => this.jumpTo(x.index, cx))
            .child(x.label))))
        .child(Scrollbar.vertical("rm-toc").absolute().inset_0()));
  }

  convoList(t, items) {
    const body = div().id("rm-body").relative().flex_1().min_w(0).h_full().overflow_hidden()
      .on_size_change((s, cx) => {
        if (Math.round(s.width) === Math.round(this.bodyW)) return;
        this.bodyW = s.width;
        cx.notify();
      });
    const cover = () => div().absolute().inset_0().bg(t.background);
    if (!this.bodyW) return body;
    const now = Date.now();
    const missing = items.filter((it) => !this.heights.has(this.measureKey(it)));
    // Messages still being measured: never measured, or their height changed recently.
    const measuring = items.filter((it) => {
      const at = this.measuredAt.get(this.measureKey(it));
      return at === undefined || now - at < MEASURE_QUIET;
    });
    // The hidden copies, laid out at the real width (visibility hidden: laid out, not painted).
    const measurer = () => v_flex().absolute().top(0).left(0).w(this.bodyW).invisible()
      .children(measuring.map((it) => {
        const mk = this.measureKey(it);
        return div().id(`rm-m-${mk}`).w_full().flex_none().child(this.item(t, it))
          .on_size_change((s, cx) => {
            // Nested sizes come back zoomed (app zoom), the body's don't: the width tells the scale.
            const h = s.width > 0 ? s.height * (this.bodyW / s.width) : s.height;
            const old = this.heights.get(mk);
            if (old !== undefined && Math.abs(old - h) < 0.5) return;
            this.heights.set(mk, h);
            this.lastH.set(it.key, h);
            const at = Date.now();
            this.measuredAt.set(mk, at);
            this.measureUntil = Math.max(this.measureUntil, at + MEASURE_QUIET);
            // A late change while the list sits at the end it was just sent to: send it again.
            // Right after opening it stays covered; later it moves without a cover flash.
            if (old !== undefined && at - this.bottomAt < BOTTOM_HOLD && (!this.pending || this.pending.bottom)) {
              this.pending = { bottom: true, quiet: this.bottomQuiet || at - this.bottomAt > 300 };
              this.settle = 0;
            }
            if (items.every((x) => this.heights.has(this.measureKey(x)))) cx.notify();
          });
      }));
    if (missing.length && !this.keepShown) return body.child(measurer()).child(cover());
    if (!missing.length) this.keepShown = false;
    // During a quiet re-read, changed messages stand in at their last height until measured.
    const sizes = items.map((it) => this.heights.get(this.measureKey(it)) ?? this.lastH.get(it.key) ?? 0).concat(END_PAD);
    // A new request starts its own settle, rather than riding out the end of an older one.
    // Scroll requests wait until every height is real, or they'd land on the stand-ins.
    if (this.wantBottom && !missing.length) {
      this.pending = { bottom: true, quiet: this.wantBottom === "quiet" };
      this.wantBottom = false;
      this.settle = 0;
    }
    if (this.pending && this.settle === 0 && !missing.length) {
      if (this.pending.bottom) { this.bottomAt = now; this.bottomQuiet = !!this.pending.quiet; }
      this.applyPending();
      this.settle = 3;
    }
    const covered = this.settle > 0 && this.pending?.bottom && !this.pending.quiet;
    return body
      .when(measuring.length > 0, (el) => el.child(measurer()))
      .child(v_virtual_list("rm-vlist", items.length + 1, sizes, (i) => (i < items.length ? `${items[i].key}-${items[i].sig}` : "rm-end"),
        (range) => {
          this.visStart = Math.min(range.start, items.length - 1);
          this.visEnd = range.end;
          const out = [];
          for (let i = range.start; i < range.end; i++) out.push(i < items.length ? this.item(t, items[i]) : div().h(END_PAD));
          return out;
        })
        .track_scroll(this.scroll).size_full())
      .child(Scrollbar.vertical("rm-vlist").absolute().inset_0())
      .when(covered, (el) => el.child(cover()));
  }
}
