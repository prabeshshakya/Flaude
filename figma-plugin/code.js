// Flaude: plugin main thread.
// Reads the selection, packs it into compact context for Claude, builds node
// links, exports screenshots, and tracks which layers changed during a run.

const DEFAULT_SIZE = { width: 400, height: 720 };
// Snapshot budget: ~16k chars is roughly 4k tokens. Claude reads deeper with
// tools only when it needs to.
const LIMITS = { depth: 4, nodes: 150, children: 40, text: 200, json: 16000, imageEdge: 800 };

// ---------- helpers ----------

const r1 = (n) => Math.round(n * 10) / 10;
const isMixed = (v) => v === figma.mixed;
function safe(fn, fallback) {
  try {
    const v = fn();
    return isMixed(v) ? 'mixed' : v;
  } catch (e) {
    return fallback;
  }
}

function hex(c) {
  const h = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase();
}

function fileKey() {
  if (figma.fileKey) return figma.fileKey;
  const url = figma.root.getPluginData('fileUrl');
  const m = url && url.match(/figma\.com\/(?:design|file|proto|board)\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

function fileUrl() {
  const key = fileKey();
  if (!key) return null;
  const slug = encodeURIComponent((figma.root.name || 'Untitled').replace(/\s+/g, '-'));
  return `https://www.figma.com/design/${key}/${slug}`;
}

function nodeLink(id) {
  const base = fileUrl();
  return base ? `${base}?node-id=${encodeURIComponent(id.replace(/:/g, '-'))}` : null;
}

function pageOf(node) {
  let n = node;
  while (n && n.type !== 'PAGE') n = n.parent;
  return n;
}

// ---------- name lookups (cached per pack) ----------

function makeResolver() {
  const vars = new Map();
  const styles = new Map();
  return {
    async variable(id) {
      if (!id) return null;
      if (!vars.has(id)) {
        let name = id;
        try {
          const v = await figma.variables.getVariableByIdAsync(id);
          if (v) name = v.name;
        } catch (e) {}
        vars.set(id, name);
      }
      return vars.get(id);
    },
    async style(id) {
      if (!id || isMixed(id)) return isMixed(id) ? 'mixed' : null;
      if (!styles.has(id)) {
        let name = null;
        try {
          const s = await figma.getStyleByIdAsync(id);
          if (s) name = s.name;
        } catch (e) {}
        styles.set(id, name);
      }
      return styles.get(id);
    },
  };
}

async function packPaints(paints, resolve) {
  if (paints === 'mixed' || isMixed(paints)) return 'mixed';
  if (!Array.isArray(paints)) return undefined;
  const out = [];
  for (const p of paints) {
    if (p.visible === false) continue;
    if (p.type === 'SOLID') {
      let s = hex(p.color);
      if (p.opacity != null && p.opacity < 1) s += ` ${Math.round(p.opacity * 100)}%`;
      const vid = p.boundVariables && p.boundVariables.color && p.boundVariables.color.id;
      if (vid) s += ` {${await resolve.variable(vid)}}`;
      out.push(s);
    } else {
      out.push(String(p.type || 'paint').toLowerCase());
    }
  }
  return out.length ? out : undefined;
}

async function packBound(node, resolve) {
  const bv = safe(() => node.boundVariables, null);
  if (!bv || typeof bv !== 'object') return undefined;
  const out = {};
  for (const key of Object.keys(bv)) {
    if (key === 'fills' || key === 'strokes') continue; // shown on paints
    const val = bv[key];
    const list = Array.isArray(val) ? val : [val];
    const names = [];
    for (const a of list) if (a && a.id) names.push(await resolve.variable(a.id));
    if (names.length) out[key] = names.length === 1 ? names[0] : names;
  }
  return Object.keys(out).length ? out : undefined;
}

// ---------- the packer ----------

async function packNode(node, depth, st, resolve) {
  st.count++;
  const o = { id: node.id, name: node.name, type: node.type };
  if (st.count > LIMITS.nodes) {
    o.truncated = true;
    return o;
  }
  if ('visible' in node && !node.visible) o.hidden = true;
  if ('width' in node) o.box = [r1(node.x), r1(node.y), r1(node.width), r1(node.height)];

  const layoutMode = safe(() => node.layoutMode, 'NONE');
  if (layoutMode && layoutMode !== 'NONE') {
    o.layout = {
      mode: layoutMode,
      gap: safe(() => node.itemSpacing),
      pad: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].map((v) => (isMixed(v) ? 'mixed' : v)),
      align: [safe(() => node.primaryAxisAlignItems), safe(() => node.counterAxisAlignItems)],
    };
    if (safe(() => node.layoutWrap) === 'WRAP') o.layout.wrap = true;
  }
  const sh = safe(() => node.layoutSizingHorizontal);
  const sv = safe(() => node.layoutSizingVertical);
  if (sh || sv) o.sizing = [sh, sv];

  if ('fills' in node) {
    const fills = await packPaints(safe(() => node.fills), resolve);
    if (fills) o.fills = fills;
    const fillStyle = await resolve.style(safe(() => node.fillStyleId));
    if (fillStyle) o.fillStyle = fillStyle;
  }
  if ('strokes' in node) {
    const strokes = await packPaints(safe(() => node.strokes), resolve);
    if (strokes) {
      o.strokes = strokes;
      o.strokeWeight = safe(() => node.strokeWeight);
    }
  }
  const radius = safe(() => node.cornerRadius);
  if (radius) o.radius = radius;
  const opacity = safe(() => node.opacity, 1);
  if (opacity !== 1) o.opacity = r1(opacity);
  const effectStyle = await resolve.style(safe(() => node.effectStyleId));
  if (effectStyle) o.effectStyle = effectStyle;
  const bound = await packBound(node, resolve);
  if (bound) o.vars = bound;

  if (node.type === 'TEXT') {
    const chars = node.characters || '';
    o.text = chars.length > LIMITS.text ? chars.slice(0, LIMITS.text) + '…' : chars;
    const font = safe(() => node.fontName);
    o.font = font === 'mixed' ? 'mixed' : font ? `${font.family} ${font.style}` : undefined;
    o.fontSize = safe(() => node.fontSize);
    const ts = await resolve.style(safe(() => node.textStyleId));
    if (ts) o.textStyle = ts;
  }

  if (node.type === 'INSTANCE') {
    try {
      const main = await node.getMainComponentAsync();
      if (main) {
        o.component = main.parent && main.parent.type === 'COMPONENT_SET' ? `${main.parent.name} / ${main.name}` : main.name;
        if (main.remote) o.fromLibrary = true;
      }
    } catch (e) {}
    const props = safe(() => node.componentProperties, null);
    if (props) {
      o.props = {};
      for (const k of Object.keys(props)) o.props[k] = props[k].value;
    }
  }
  if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
    const defs = safe(() => node.componentPropertyDefinitions, null);
    if (defs) o.propDefs = Object.keys(defs);
  }

  if ('children' in node && node.children.length) {
    if (depth > 0) {
      const kids = node.children.slice(0, LIMITS.children);
      o.children = [];
      for (const k of kids) o.children.push(await packNode(k, depth - 1, st, resolve));
      if (node.children.length > kids.length) o.moreChildren = node.children.length - kids.length;
    } else {
      o.childCount = node.children.length;
    }
  }
  return o;
}

async function resolveNodes(ids) {
  const nodes = [];
  for (const id of ids || []) {
    const n = await figma.getNodeByIdAsync(id);
    if (n && n.type !== 'DOCUMENT' && n.type !== 'PAGE') nodes.push(n);
  }
  return nodes;
}

async function buildContext(ids, withImages, full) {
  const nodes = await resolveNodes(ids);
  const page = nodes.length ? pageOf(nodes[0]) : figma.currentPage;
  const ctx = {
    file: { key: fileKey(), name: figma.root.name, url: fileUrl() },
    page: { id: page.id, name: page.name },
  };

  if (full === false) {
    // Claude already has this target's snapshot (or page overview) in the conversation.
    ctx.target = nodes.map((n) => ({ id: n.id, name: n.name, type: n.type, link: nodeLink(n.id) }));
    ctx.note = nodes.length
      ? 'Same target as before; use the snapshot already in this conversation.'
      : 'Same page as before; use the page overview already in this conversation.';
    return { context: ctx, images: [], links: nodes.map((n) => ({ id: n.id, name: n.name, link: nodeLink(n.id) })) };
  }

  if (nodes.length) {
    let depth = LIMITS.depth;
    let packed;
    // Shrink depth until the snapshot fits the budget.
    while (true) {
      const st = { count: 0 };
      const resolve = makeResolver();
      packed = [];
      for (const n of nodes) packed.push(await packNode(n, depth, st, resolve));
      if (JSON.stringify(packed).length <= LIMITS.json || depth <= 1) break;
      depth -= 1;
    }
    ctx.target = nodes.map((n, i) => ({ link: nodeLink(n.id), parent: n.parent ? { id: n.parent.id, name: n.parent.name } : null, layer: packed[i] }));
  } else {
    ctx.target = [];
    ctx.pageOverview = page.children.slice(0, 30).map((n) => ({
      id: n.id,
      name: n.name,
      type: n.type,
      size: 'width' in n ? [Math.round(n.width), Math.round(n.height)] : undefined,
      link: nodeLink(n.id),
    }));
  }

  const images = [];
  // One picture of the first target layer is enough for Claude to see it.
  const first = nodes[0];
  if (withImages && first && 'exportAsync' in first && first.width && first.height) {
    try {
      const scale = Math.max(0.05, Math.min(2, LIMITS.imageEdge / Math.max(first.width, first.height)));
      const bytes = await first.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } });
      images.push({ data: figma.base64Encode(bytes), mediaType: 'image/png' });
    } catch (e) {}
  }
  return { context: ctx, images, links: nodes.map((n) => ({ id: n.id, name: n.name, link: nodeLink(n.id) })) };
}

// ---------- selection → UI ----------

let selectionTimer = null;
async function postSelection() {
  const sel = figma.currentPage.selection.slice(0, 8);
  const items = [];
  for (const n of sel) {
    let thumb = null;
    if (sel.length <= 4 && 'exportAsync' in n && n.width && n.height) {
      try {
        const scale = Math.max(0.01, Math.min(2, 80 / Math.max(n.width, n.height)));
        thumb = figma.base64Encode(await n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } }));
      } catch (e) {}
    }
    items.push({ id: n.id, name: n.name, type: n.type, thumb });
  }
  figma.ui.postMessage({ type: 'selection', items, total: figma.currentPage.selection.length, page: figma.currentPage.name });
}
function queueSelection() {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(postSelection, 150);
}

// ---------- change tracking during a run ----------

let tracking = false;
const changed = new Set();
const created = new Set();
let trackedPage = null;

function onNodeChange(e) {
  if (!tracking) return;
  for (const c of e.nodeChanges) {
    // REMOTE = written by the Figma MCP server, not by you or this plugin.
    if (c.origin !== 'REMOTE' || c.type === 'DELETE') continue;
    changed.add(c.id);
    if (c.type === 'CREATE') created.add(c.id);
  }
}
function watchPage(page) {
  if (trackedPage === page) return;
  if (trackedPage) trackedPage.off('nodechange', onNodeChange);
  trackedPage = page;
  page.on('nodechange', onNodeChange);
}

async function liveNodes(ids) {
  const out = [];
  for (const id of ids) {
    const n = await figma.getNodeByIdAsync(id);
    if (n && !n.removed && n.type !== 'PAGE' && n.type !== 'DOCUMENT') out.push(n);
  }
  return out;
}
function topMost(nodes) {
  const set = new Set(nodes.map((n) => n.id));
  return nodes.filter((n) => {
    for (let p = n.parent; p; p = p.parent) if (set.has(p.id)) return false;
    return true;
  });
}
function within(node, ancestorIds) {
  for (let p = node; p; p = p.parent) if (ancestorIds.has(p.id)) return true;
  return false;
}
function insideInstance(node) {
  for (let p = node.parent; p; p = p.parent) if (p.type === 'INSTANCE') return true;
  return false;
}
const brief = (n) => ({ id: n.id, name: n.name, type: n.type });

async function thumb(node, edge) {
  if (!node || !('exportAsync' in node) || !node.width || !node.height) return null;
  try {
    const scale = Math.max(0.01, Math.min(2, (edge || 240) / Math.max(node.width, node.height)));
    return figma.base64Encode(await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } }));
  } catch (e) {
    return null;
  }
}

// ---------- snapshots and revert ----------
// Before a Build, each target layer is cloned onto a page called
// "Claude Bridge snapshots". Revert puts the clone back where the original
// was and removes layers Claude added. Records live in the file, so Revert
// still works after closing the plugin. The last 10 builds are kept.

const MAX_RUNS = 10;
const SNAP_PAGE = 'Claude Bridge snapshots';

function loadRuns() {
  try { return JSON.parse(figma.root.getPluginData('runs') || '[]'); } catch (e) { return []; }
}
async function saveRuns(runs) {
  while (runs.length > MAX_RUNS) {
    const old = runs.shift();
    for (const sn of old.snaps || []) {
      const n = await figma.getNodeByIdAsync(sn.snapId);
      if (n && !n.removed) n.remove();
    }
  }
  figma.root.setPluginData('runs', JSON.stringify(runs));
}
async function snapshotPage() {
  let page = figma.root.children.find((p) => p.getPluginData('claudeSnapshots') === '1');
  if (!page) {
    page = figma.createPage();
    page.name = SNAP_PAGE;
    page.setPluginData('claudeSnapshots', '1');
  }
  await page.loadAsync();
  return page;
}

let currentRun = null; // { runId, targetIds:Set }

async function runStart(msg) {
  changed.clear();
  created.clear();
  tracking = true;
  watchPage(figma.currentPage);
  const targets = await liveNodes(msg.ids || []);
  currentRun = { runId: msg.runId, targetIds: new Set(targets.map((n) => n.id)) };

  const result = { revert: { available: false, note: '' } };
  if (!msg.snapshot) return result;

  const notes = [];
  const snaps = [];
  if (!targets.length) notes.push('No target, so Revert can only remove layers Claude adds.');
  let page = null;
  for (const n of targets) {
    if (insideInstance(n)) { notes.push(`${n.name} is inside an instance and can't be snapshotted.`); continue; }
    if (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') { notes.push(`${n.name} is a main component; use version history to roll it back.`); continue; }
    try {
      page = page || (await snapshotPage());
      const parent = n.parent;
      const autoChild = 'layoutMode' in parent && parent.layoutMode !== 'NONE' && n.layoutPositioning !== 'ABSOLUTE';
      const rec = { origId: n.id, parentId: parent.id, pageId: pageOf(n).id, index: parent.children.indexOf(n), x: n.x, y: n.y, autoChild };
      const clone = n.clone();
      page.appendChild(clone);
      clone.setPluginData('snapOf', n.id);
      clone.locked = true;
      rec.snapId = clone.id;
      snaps.push(rec);
    } catch (e) {
      notes.push(`Couldn't snapshot ${n.name}: ${e.message}`);
    }
  }
  const runs = loadRuns();
  runs.push({ runId: msg.runId, at: Date.now(), snaps, created: [], targetIds: [...currentRun.targetIds] });
  await saveRuns(runs);
  result.revert = { available: true, note: notes.join(' ') };
  return result;
}

async function runEnd(msg) {
  tracking = false;
  const targetIds = currentRun && currentRun.runId === msg.runId ? currentRun.targetIds : new Set();
  const changedNodes = topMost(await liveNodes([...new Set([...changed, ...(msg.mentionedIds || [])])]));
  const createdTop = topMost(await liveNodes([...created]));
  const createdIds = new Set(createdTop.map((n) => n.id));
  const outside = changedNodes.filter((n) => !createdIds.has(n.id) && !within(n, targetIds) && !within(n, createdIds));


  const runs = loadRuns();
  const run = runs.find((r) => r.runId === msg.runId);
  if (run) {
    run.created = createdTop.map((n) => n.id);
    await saveRuns(runs);
  }

  let options = [];
  if (msg.explore) {
    const ids = (msg.optionIds && msg.optionIds.length ? msg.optionIds : createdTop.map((n) => n.id)).slice(0, 6);
    for (const n of await liveNodes(ids)) options.push({ ...brief(n), thumb: await thumb(n, 360) });
  }
  return {
    items: changedNodes.slice(0, 100).map(brief),
    created: createdTop.slice(0, 100).map(brief),
    outside: outside.slice(0, 20).map(brief),
    options,
  };
}

async function revertRun(runId) {
  const runs = loadRuns();
  const run = runs.find((r) => r.runId === runId);
  if (!run) return { ok: false, message: 'Nothing to revert: the snapshot is gone (only the last 10 builds are kept).' };
  let removed = 0, restored = 0, missing = 0;
  for (const n of await liveNodes(run.created || [])) { n.remove(); removed++; }
  for (const r of run.snaps) {
    const snap = await figma.getNodeByIdAsync(r.snapId);
    if (!snap || snap.removed) { missing++; continue; }
    const orig = await figma.getNodeByIdAsync(r.origId);
    let parent = await figma.getNodeByIdAsync(r.parentId);
    if (parent && !parent.removed) await pageOf(parent).loadAsync();
    let index = r.index;
    if (orig && !orig.removed) {
      if (parent && orig.parent === parent) index = parent.children.indexOf(orig);
      orig.remove();
    }
    snap.locked = false;
    snap.setPluginData('snapOf', '');
    if (parent && !parent.removed) {
      parent.insertChild(Math.max(0, Math.min(index, parent.children.length)), snap);
      if (!r.autoChild) { snap.x = r.x; snap.y = r.y; }
    } else {
      const page = await figma.getNodeByIdAsync(r.pageId);
      if (!page) { missing++; continue; }
      await page.loadAsync();
      page.appendChild(snap);
      snap.x = r.x;
      snap.y = r.y;
    }
    restored++;
  }
  figma.root.setPluginData('runs', JSON.stringify(runs.filter((x) => x.runId !== runId)));
  figma.commitUndo();
  const parts = [];
  if (restored) parts.push(`restored ${restored} layer${restored === 1 ? '' : 's'}`);
  if (removed) parts.push(`removed ${removed} added layer${removed === 1 ? '' : 's'}`);
  if (missing) parts.push(`${missing} snapshot${missing === 1 ? ' was' : 's were'} missing`);
  return { ok: restored + removed > 0, message: parts.length ? `Reverted: ${parts.join(', ')}.` : 'Nothing changed.' };
}

async function keepRun(runId) {
  const runs = loadRuns();
  const run = runs.find((r) => r.runId === runId);
  if (run) for (const sn of run.snaps) { const n = await figma.getNodeByIdAsync(sn.snapId); if (n && !n.removed) n.remove(); }
  figma.root.setPluginData('runs', JSON.stringify(runs.filter((x) => x.runId !== runId)));
  return { ok: true };
}

// Explore: put the chosen option where the original was, delete the rest.
async function useOption({ optionId, originalId, otherIds }) {
  const opt = await figma.getNodeByIdAsync(optionId);
  if (!opt || opt.removed) return { ok: false, message: 'That option no longer exists.' };
  const orig = originalId ? await figma.getNodeByIdAsync(originalId) : null;
  if (orig && !orig.removed && orig.parent && !insideInstance(orig)) {
    const parent = orig.parent;
    const idx = parent.children.indexOf(orig);
    const autoChild = 'layoutMode' in parent && parent.layoutMode !== 'NONE';
    const { x, y, name } = orig;
    parent.insertChild(idx, opt);
    if (!autoChild) { opt.x = x; opt.y = y; }
    opt.name = name;
    orig.remove();
  }
  for (const n of await liveNodes(otherIds || [])) if (n.id !== opt.id) n.remove();
  figma.commitUndo();
  figma.currentPage.selection = pageOf(opt) === figma.currentPage ? [opt] : [];
  return { ok: true, message: 'Done. Cmd+Z undoes it.' };
}

// ---------- design checks ----------
// Exact, instant checks the plugin can do itself. Claude adds judgement.

const SPACING_SCALE = [0, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80];
const RADIUS_SCALE = [0, 2, 4, 8, 12, 16];
const DEFAULT_NAME = /^(Frame|Rectangle|Group|Ellipse|Vector|Line|Polygon|Star|Component|Instance|Section|Image)( \d+)?$/;
const MAX_LINT_NODES = 400;
const MAX_FINDINGS = 200;

function lum(c) {
  const f = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
function solidOf(paints) {
  if (!Array.isArray(paints)) return null;
  for (let i = paints.length - 1; i >= 0; i--) {
    const p = paints[i];
    if (p.visible !== false && p.type === 'SOLID' && (p.opacity == null || p.opacity >= 0.99)) return p.color;
  }
  return null;
}
function backgroundOf(node) {
  for (let p = node.parent; p && p.type !== 'PAGE'; p = p.parent) {
    const c = 'fills' in p ? solidOf(safe(() => p.fills, null)) : null;
    if (c) return c;
  }
  return { r: 1, g: 1, b: 1 };
}

async function lint(ids) {
  const roots = await liveNodes(ids);
  if (!roots.length) roots.push(...figma.currentPage.children.slice(0, 20));
  const out = [];
  let count = 0;
  const add = (n, rule, sev, msg, safeFix) => { if (out.length < MAX_FINDINGS) out.push({ id: n.id, name: n.name, rule, sev, msg, safe: !!safeFix }); };

  const visit = (n) => {
    if (++count > MAX_LINT_NODES) return;
    if ('visible' in n && n.visible === false) { add(n, 'hidden', 'info', 'Hidden layer left in the design.'); return; }
    if (n.type !== 'TEXT' && DEFAULT_NAME.test(n.name)) add(n, 'naming', 'info', `Default name “${n.name}”.`, true);
    if (safe(() => n.hasMissingFont, false)) add(n, 'missing-font', 'error', 'Uses a font that isn’t available.');

    if ('fills' in n && n.type !== 'INSTANCE') {
      const fills = safe(() => n.fills, null);
      const styled = !!safe(() => n.fillStyleId, '');
      if (Array.isArray(fills) && !styled) {
        for (const p of fills) {
          if (p.visible === false || p.type !== 'SOLID') continue;
          if (!(p.boundVariables && p.boundVariables.color)) add(n, 'raw-color', 'warn', `Fill ${hex(p.color)} isn’t a variable or style.`, true);
        }
      }
      const strokes = safe(() => n.strokes, null);
      if (Array.isArray(strokes) && !safe(() => n.strokeStyleId, '')) {
        for (const p of strokes) {
          if (p.visible === false || p.type !== 'SOLID') continue;
          if (!(p.boundVariables && p.boundVariables.color)) add(n, 'raw-color', 'warn', `Stroke ${hex(p.color)} isn’t a variable or style.`, true);
        }
      }
    }

    if (n.type === 'TEXT') {
      if (!safe(() => n.textStyleId, '')) {
        const size = safe(() => n.fontSize);
        add(n, 'text-style', 'warn', `Text isn’t using a text style${size && size !== 'mixed' ? ` (${size}px)` : ''}.`, true);
      }
      const fg = solidOf(safe(() => n.fills, null));
      const size = safe(() => n.fontSize);
      const font = safe(() => n.fontName);
      if (fg && typeof size === 'number' && font && font !== 'mixed') {
        const bg = backgroundOf(n);
        const a = lum(fg), b = lum(bg);
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        const bold = /bold|semi|heavy|black/i.test(font.style);
        const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
        if (ratio < need) add(n, 'contrast', 'error', `Contrast ${ratio.toFixed(2)}:1 on ${hex(bg)}; needs ${need}:1.`);
      }
    }

    const mode = safe(() => n.layoutMode, 'NONE');
    if (mode && mode !== 'NONE' && n.type !== 'INSTANCE') {
      const bound = safe(() => n.boundVariables, {}) || {};
      for (const key of ['itemSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
        const v = safe(() => n[key]);
        if (typeof v !== 'number' || v === 0 || bound[key]) continue;
        const on = SPACING_SCALE.includes(v);
        const label = key === 'itemSpacing' ? 'Gap' : `Padding ${key.slice(7).toLowerCase()}`;
        add(n, 'spacing', on ? 'info' : 'warn', `${label} ${v}${on ? ' isn’t bound to a spacing variable' : ' is off the spacing scale'}.`, true);
      }
    }
    const radius = safe(() => n.cornerRadius);
    if (typeof radius === 'number' && radius > 0 && n.type !== 'INSTANCE' && !(safe(() => n.boundVariables, {}) || {}).topLeftRadius && !RADIUS_SCALE.includes(radius) && radius < 999) {
      add(n, 'radius', 'info', `Radius ${radius} is off the scale.`, true);
    }
    if ((n.type === 'FRAME' || n.type === 'GROUP') && 'children' in n && n.children.length === 0 && !solidOf(safe(() => n.fills, null))) {
      add(n, 'empty', 'info', 'Empty frame.');
    }
    // Instances own their insides; don't lint the component's internals.
    if ('children' in n && n.type !== 'INSTANCE') for (const k of n.children) visit(k);
  };
  for (const r of roots) visit(r);
  return { findings: out, scanned: Math.min(count, MAX_LINT_NODES), truncated: count > MAX_LINT_NODES || out.length >= MAX_FINDINGS };
}

// ---------- focusing ----------

async function focus(ids) {
  const nodes = await resolveNodes(ids);
  if (!nodes.length) {
    figma.notify('That layer no longer exists.');
    return;
  }
  const page = pageOf(nodes[0]);
  if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
  const onPage = nodes.filter((n) => pageOf(n) === figma.currentPage);
  figma.currentPage.selection = onPage;
  figma.viewport.scrollAndZoomIntoView(onPage);
}

// ---------- messages from the UI ----------

figma.ui.onmessage = async (msg) => {
  try {
    switch (msg.type) {
      case 'ready': {
        const [settings, size] = await Promise.all([figma.clientStorage.getAsync('settings'), figma.clientStorage.getAsync('size')]);
        const key = fileKey() || 'nofile';
        const [index, legacySession, legacyTranscript] = await Promise.all([
          figma.clientStorage.getAsync(`c:${key}`),
          figma.clientStorage.getAsync(`s:${key}`),
          figma.clientStorage.getAsync(`t:${key}`),
        ]);
        figma.ui.postMessage({
          type: 'init',
          file: { key: fileKey(), name: figma.root.name, url: fileUrl(), storageKey: key },
          settings: settings || {},
          conversations: index || [],
          legacy: !index && legacyTranscript && legacyTranscript.length ? { sessionId: legacySession || null, transcript: legacyTranscript } : null,
          size: size || DEFAULT_SIZE,
        });
        await postSelection();
        break;
      }
      case 'build-context': {
        const out = await buildContext(msg.ids, msg.withImages, msg.full !== false);
        figma.ui.postMessage({ type: 'context', requestId: msg.requestId, ...out });
        break;
      }
      case 'focus':
        await focus(msg.ids);
        break;
      case 'store':
        await figma.clientStorage.setAsync(msg.key, msg.value);
        break;
      case 'load': {
        const value = await figma.clientStorage.getAsync(msg.key);
        figma.ui.postMessage({ type: 'loaded', requestId: msg.requestId, value: value === undefined ? null : value });
        break;
      }
      case 'remove':
        await figma.clientStorage.deleteAsync(msg.key);
        break;
      case 'set-file-url':
        figma.root.setPluginData('fileUrl', msg.url || '');
        figma.ui.postMessage({ type: 'file', file: { key: fileKey(), name: figma.root.name, url: fileUrl(), storageKey: fileKey() || 'nofile' } });
        break;
      case 'run-start':
        figma.ui.postMessage({ type: 'reply', requestId: msg.requestId, value: await runStart(msg) });
        break;
      case 'run-end':
        figma.ui.postMessage({ type: 'changes', runId: msg.runId, ...(await runEnd(msg)) });
        break;
      case 'revert':
        figma.ui.postMessage({ type: 'reply', requestId: msg.requestId, value: await revertRun(msg.runId) });
        break;
      case 'keep':
        figma.ui.postMessage({ type: 'reply', requestId: msg.requestId, value: await keepRun(msg.runId) });
        break;
      case 'use-option':
        figma.ui.postMessage({ type: 'reply', requestId: msg.requestId, value: await useOption(msg) });
        break;
      case 'lint':
        figma.ui.postMessage({ type: 'reply', requestId: msg.requestId, value: await lint(msg.ids || []) });
        break;
      case 'thumbs': {
        const value = [];
        for (const n of await liveNodes(msg.ids || [])) value.push({ ...brief(n), thumb: await thumb(n, msg.edge || 360) });
        figma.ui.postMessage({ type: 'reply', requestId: msg.requestId, value });
        break;
      }
      case 'resize': {
        const w = Math.max(360, Math.min(900, Math.round(msg.width)));
        const h = Math.max(420, Math.min(1200, Math.round(msg.height)));
        figma.ui.resize(w, h);
        if (msg.save) await figma.clientStorage.setAsync('size', { width: w, height: h });
        break;
      }
      case 'notify':
        figma.notify(msg.text, { timeout: msg.timeout || 2500 });
        break;
      case 'open-external':
        // Only web links. Never file:, javascript: or custom schemes.
        if (typeof msg.url === 'string' && /^https?:\/\//i.test(msg.url) && msg.url.length < 4096) figma.openExternal(msg.url);
        break;
    }
  } catch (e) {
    figma.ui.postMessage({ type: 'plugin-error', message: String((e && e.message) || e), requestId: msg.requestId });
  }
};

// ---------- start ----------

(async () => {
  const size = (await figma.clientStorage.getAsync('size')) || DEFAULT_SIZE;
  figma.showUI(__html__, { themeColors: true, width: size.width, height: size.height, title: 'Claude Bridge' });
  figma.root.setRelaunchData({ open: 'Chat with Claude about this file' });
  watchPage(figma.currentPage);
  figma.on('selectionchange', queueSelection);
  figma.on('currentpagechange', () => {
    watchPage(figma.currentPage);
    queueSelection();
  });
})();
