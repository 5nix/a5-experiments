// 被试端虚拟办公桌面。
// 协议层（串行命令队列、实际可见后报告、草稿保存、轮询与恢复）沿用基础实现的语义；
// 本文件只替换表现层：所有研究文案、表格、选项均来自服务端 view，不在组件内写入。

const params = new URLSearchParams(location.hash.slice(1));
const sessionId = params.get('session'), token = params.get('token');
const endpoint = `/api/participant/sessions/${sessionId}`;
let current, generation = 0, queue = Promise.resolve(), pending = 0, urls = [], breakClock, restClock, ready = false;
let gated = [];

/* ───────────────────────── 协议层 ───────────────────────── */

const uuid = () => crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
const client = () => ({ timestamp_iso: new Date().toISOString(), monotonic_ms: performance.now(), time_origin_ms: performance.timeOrigin, visibility_state: document.visibilityState, user_agent: navigator.userAgent });
async function api(path = '', options = {}) {
  const response = await fetch(endpoint + path, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) { const problem = new Error(data.error ?? '请求失败。'); problem.status = response.status; throw problem; }
  return data;
}
function command(action, extra = {}, pageToken = current.page_token) {
  const payload = { command_id: uuid(), page_token: pageToken, action, client: client(), ...extra };
  pending++;
  const operation = queue.then(async () => {
    const options = { method: 'POST', body: JSON.stringify(payload) };
    try { return await api('/commands', options); }
    catch (problem) {
      // 只对网络中断重试同一个操作ID及完全相同的请求体，防止提交已落盘但响应丢失导致重复。
      if (problem instanceof TypeError) return api('/commands', options);
      throw problem;
    }
  });
  queue = operation.catch(() => {}).finally(() => { pending--; });
  return operation;
}
function answer(form) {
  const data = new FormData(form), result = {};
  for (const field of current.fields) result[field.id] = field.type === 'multi' ? data.getAll(field.id) : data.get(field.id) ?? '';
  return result;
}

/* ───────────────────────── DOM 工具 ───────────────────────── */

function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key.startsWith('aria-') || key.startsWith('data-') || ['role', 'form', 'for'].includes(key)) node.setAttribute(key, value === true ? '' : String(value));
    else node[key] = value;
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}
const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  node.append(...children); return node;
}
const CIRCLE = 'M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18z';
const ICONS = {
  minimize: ['M6 12h12'],
  maximize: ['M7.5 6h9A1.5 1.5 0 0 1 18 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 16.5v-9A1.5 1.5 0 0 1 7.5 6z'],
  restore: ['M6.5 9h8A1.5 1.5 0 0 1 16 10.5v7a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 5 17.5v-7A1.5 1.5 0 0 1 6.5 9z', 'M9 6.5A1.5 1.5 0 0 1 10.5 5h7A1.5 1.5 0 0 1 19 6.5v7a1.5 1.5 0 0 1-1.5 1.5'],
  close: ['M7 7l10 10', 'M17 7L7 17'],
  chevron: ['M7 10l5 5 5-5'],
  note: ['M7.5 4h9A2.5 2.5 0 0 1 19 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 17.5v-11A2.5 2.5 0 0 1 7.5 4z', 'M8.5 9h7', 'M8.5 12.5h7', 'M8.5 16h4'],
  table: ['M6.5 5h11A1.5 1.5 0 0 1 19 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 17.5v-11A1.5 1.5 0 0 1 6.5 5z', 'M5 10h14', 'M10 10v9'],
  check: [CIRCLE, 'M8.2 12.4l2.6 2.6 5-5.4'],
  info: [CIRCLE, 'M12 11v5.2', 'M12 7.6v.2'],
  pause: [CIRCLE, 'M10 9v6', 'M14 9v6'],
  error: [CIRCLE, 'M12 7.5v5.2', 'M12 16.2v.2'],
  coffee: ['M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5V9z', 'M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16', 'M8.5 3.5v2.5', 'M12 3.5v2.5'],
  code: ['M9 8l-4 4 4 4', 'M15 8l4 4-4 4'],
  doc: ['M7 3.5h6.5L18 8v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1-1.5z', 'M13.5 3.5V8H18', 'M9 12.5h6', 'M9 16h6'],
};
function icon(name, size = 16, cls = '') {
  return svg('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', focusable: 'false', class: `icon ${cls}`.trim() },
    ...ICONS[name].map(d => svg('path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })));
}
let gradientSeq = 0;
function appIcon(kind, size = 24) {
  const id = `app-gradient-${++gradientSeq}`;
  const stops = { note: ['#ffd94a', '#f2a900'], sheet: ['#3fc07a', '#107c41'], doc: ['#5aa7ff', '#185abd'], file: ['#c9d3df', '#8a99ab'] }[kind] ?? ['#45a6ff', '#0a56b3'];
  const defs = svg('defs', {}, svg('linearGradient', { id, x1: 0, y1: 0, x2: 1, y2: 1 },
    svg('stop', { offset: '0', 'stop-color': stops[0] }), svg('stop', { offset: '1', 'stop-color': stops[1] })));
  const page = (band) => [
    svg('path', { d: 'M8 3h11l7 7v17a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', fill: '#fff', stroke: 'rgba(0,0,0,.18)', 'stroke-width': 1 }),
    svg('path', { d: 'M19 3v5a2 2 0 0 0 2 2h5', fill: '#eef1f5', stroke: 'rgba(0,0,0,.18)', 'stroke-width': 1 }),
    svg('rect', { x: 3, y: 15, width: 15, height: 11, rx: 2.2, fill: `url(#${id})` }),
    ...band,
  ];
  const parts = {
    note: [
      svg('rect', { x: 5, y: 4, width: 22, height: 25, rx: 4.5, fill: `url(#${id})` }),
      svg('rect', { x: 8, y: 10, width: 16, height: 16, rx: 2, fill: '#fff' }),
      svg('path', { d: 'M11 14.5h10M11 18h10M11 21.5h6', stroke: '#d08f00', 'stroke-width': 1.7, 'stroke-linecap': 'round' }),
      svg('path', { d: 'M11 3.5v4M16 3.5v4M21 3.5v4', stroke: '#8a5a00', 'stroke-width': 1.8, 'stroke-linecap': 'round' }),
    ],
    sheet: page([svg('path', { d: 'M6.5 18.5h8M6.5 22.5h8M10.5 16.5v8', stroke: '#fff', 'stroke-width': 1.5, 'stroke-linecap': 'round' }), svg('path', { d: 'M21 15h2M21 19h2M21 23h2', stroke: '#9fd3b4', 'stroke-width': 1.6, 'stroke-linecap': 'round' })]),
    doc: page([svg('path', { d: 'M6.5 18.5h8M6.5 22.5h5', stroke: '#fff', 'stroke-width': 1.6, 'stroke-linecap': 'round' }), svg('path', { d: 'M21 15h2M21 19h2M21 23h2', stroke: '#a9c8f0', 'stroke-width': 1.6, 'stroke-linecap': 'round' })]),
    file: page([svg('path', { d: 'M6.5 20.5h8', stroke: '#fff', 'stroke-width': 1.6, 'stroke-linecap': 'round' })]),
    work: [
      svg('rect', { x: 3, y: 3, width: 26, height: 26, rx: 7, fill: `url(#${id})` }),
      svg('rect', { x: 9, y: 8.5, width: 14, height: 17, rx: 2.2, fill: '#fff' }),
      svg('rect', { x: 12.5, y: 6.5, width: 7, height: 4, rx: 1.6, fill: '#cfe6ff' }),
      svg('path', { d: 'M12 15l1.6 1.6L16.5 13.6M12 20.5h8', stroke: '#0a56b3', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none' }),
    ],
  }[kind];
  return svg('svg', { viewBox: '0 0 32 32', width: size, height: size, 'aria-hidden': 'true', focusable: 'false', class: 'app-icon' }, defs, ...parts);
}

/* ───────────────────────── 窗口管理 ───────────────────────── */

const desktop = document.querySelector('#desktop');
const taskbarApps = document.querySelector('#taskbar-apps'), tray = document.querySelector('#tray-start');
const windows = [];
let zTop = 10;

// 窗口只做自动排列：不拖动、不调整大小，减少位置和遮挡相关的意外。
function makeWindow({ id, title, kind, closable = true, onMinimize, onClose }) {
  const node = h('section', { class: 'win', id, role: 'region', 'aria-label': title });
  const titleText = h('span', { class: 'win-title', text: title });
  const win = { node, titleText, maximized: false, minimized: false, hidden: false, geom: { x: 0, y: 0, w: 600, h: 400 } };
  win.maxButton = h('button', { type: 'button', class: 'caption-btn', title: '最大化', 'aria-label': '最大化', onclick: () => toggleMaximize(win) }, icon('maximize', 16));
  const caption = h('div', { class: 'caption' },
    h('button', { type: 'button', class: 'caption-btn', title: '最小化', 'aria-label': '最小化', onclick: () => { onMinimize?.(); minimize(win); } }, icon('minimize', 16)),
    win.maxButton,
    // 工作台承载整个流程，关闭按钮保留外观但置灰不可用。
    h('button', { type: 'button', class: 'caption-btn close', title: closable ? '关闭' : '', 'aria-label': '关闭', disabled: !closable, onclick: () => onClose?.() }, icon('close', 16)));
  const bar = h('div', { class: 'titlebar' }, h('span', { class: 'win-icon' }, appIcon(kind, 16)), titleText, caption);
  const body = h('div', { class: 'win-body' });
  node.append(bar, body);
  Object.assign(win, { bar, body });
  node.addEventListener('pointerdown', () => focusWindow(win), true);
  bar.addEventListener('dblclick', event => { if (!event.target.closest('button')) toggleMaximize(win); });
  desktop.append(node); windows.push(win);
  return win;
}
function place(win, geom) {
  win.geom = geom;
  const style = win.node.style;
  style.left = `${geom.x}px`; style.top = `${geom.y}px`; style.width = `${geom.w}px`; style.height = `${geom.h}px`;
}
const compact = () => desktop.clientWidth < 760;
function focusWindow(win) {
  if (win.hidden) return;
  win.node.style.zIndex = String(++zTop);
  for (const other of windows) other.node.classList.toggle('active', other === win);
  syncTaskbar();
}
function topWindow() { return windows.filter(w => !w.hidden && !w.minimized).sort((a, b) => Number(b.node.style.zIndex) - Number(a.node.style.zIndex))[0]; }
function minimize(win) {
  win.minimized = true; win.node.classList.add('minimized'); win.node.classList.remove('active');
  const next = topWindow(); if (next) focusWindow(next); else syncTaskbar();
  layout();
}
function restore(win) {
  if (win.hidden) return;
  const was = win.minimized;
  win.minimized = false; win.node.classList.remove('minimized'); focusWindow(win); layout();
  if (was) win.node.dispatchEvent(new Event('restored'));
}
function setMaximized(win, value) {
  win.maximized = value;
  win.node.classList.toggle('maximized', value);
  win.maxButton.replaceChildren(icon(value ? 'restore' : 'maximize', 16));
  win.maxButton.title = value ? '向下还原' : '最大化'; win.maxButton.setAttribute('aria-label', win.maxButton.title);
}
function toggleMaximize(win) { setMaximized(win, !win.maximized); focusWindow(win); layout(); }
function fromTaskbar(win) {
  if (win.minimized) restore(win);
  else if (win.node.classList.contains('active')) minimize(win);
  else focusWindow(win);
}
function taskButton(label, kind, onClick) {
  const button = h('button', { type: 'button', class: 'tb-app', title: label, 'aria-label': label, onclick: onClick }, appIcon(kind, 24), h('span', { class: 'tb-indicator' }));
  taskbarApps.append(button); return button;
}

const main = makeWindow({ id: 'workbench', title: '工作台', kind: 'work', closable: false });
const pageNode = h('div', { class: 'page' });
const errorNode = h('p', { class: 'cmd-error', role: 'alert' });
const actionsNode = h('div', { class: 'cmd-actions' });
const footer = h('footer', { class: 'cmdbar' }, errorNode, actionsNode);
main.body.append(pageNode, footer);
const mainButton = taskButton('工作台', 'work', () => fromTaskbar(main));

const notepad = makeWindow({ id: 'scratchpad', title: '草稿本', kind: 'note',
  onMinimize: () => flushScratch().catch(() => {}), onClose: () => closeNotepad() });
notepad.hidden = true; notepad.node.classList.add('closed');
const scratch = { token: null, timer: null, saved: '', saving: 0, failed: false };
const scratchArea = h('textarea', { class: 'note-text', spellcheck: false });
const scratchStatus = h('span', { class: 'note-status' }), scratchCount = h('span', { class: 'note-count' });
notepad.body.append(scratchArea, h('div', { class: 'note-statusbar' }, scratchStatus, scratchCount));
const noteButton = taskButton('草稿本', 'note', () => {
  if (notepad.hidden) openNotepad();
  else { if (!notepad.minimized && notepad.node.classList.contains('active')) flushScratch().catch(() => {}); fromTaskbar(notepad); }
});
noteButton.hidden = true;

// 补充资料以“附件”形式出现：点开后在独立的查看器窗口中显示，关闭即收起。
const viewer = makeWindow({ id: 'viewer', title: '', kind: 'sheet', onClose: () => closeViewer() });
viewer.hidden = true; viewer.node.classList.add('closed');
const viewerContent = h('div', { class: 'viewer-content', tabIndex: 0 });
viewer.body.append(viewerContent);
const viewerButton = taskButton('', 'sheet', () => fromTaskbar(viewer));
viewerButton.hidden = true;
let attachmentTile = null;

function syncTaskbar() {
  attachmentTile?.classList.toggle('opened', !viewer.hidden);
  for (const [win, button] of [[main, mainButton], [notepad, noteButton], [viewer, viewerButton]]) {
    button.classList.toggle('running', !win.hidden);
    button.classList.toggle('active', !win.hidden && !win.minimized && win.node.classList.contains('active'));
  }
}
function layout() {
  const W = desktop.clientWidth, H = desktop.clientHeight, small = compact();
  const gap = small ? 0 : W < 1280 ? 12 : 16;
  const shown = win => !win.hidden && !win.minimized && !win.maximized;
  // 宽屏三栏：附件在左、任务居中、草稿本在右；两侧同宽，压缩中间的工作台。
  const left = shown(viewer), right = shown(notepad);
  const sideW = Math.round(Math.min(440, Math.max(320, W * 0.21)));
  const snap = (left || right) && !small && W >= 1180 && !main.maximized;
  desktop.classList.toggle('compact', small);
  if (main.maximized || small) place(main, { x: 0, y: 0, w: W, h: H });
  else if (snap) {
    const x = left ? gap + sideW + gap : gap;
    const w = W - x - (right ? gap + sideW + gap : gap);
    place(main, { x, y: gap, w, h: H - 2 * gap });
  } else { const w = Math.min(W - 2 * gap, 1680); place(main, { x: Math.round((W - w) / 2), y: gap, w, h: H - 2 * gap }); }
  const inner = H - 2 * gap;
  if (viewer.maximized || small) place(viewer, { x: 0, y: 0, w: W, h: H });
  else if (snap) place(viewer, { x: gap, y: gap, w: sideW, h: inner });
  else { const w = Math.min(560, W - 2 * gap), hh = Math.min(520, inner); place(viewer, { x: gap, y: gap, w, h: hh }); }
  if (notepad.maximized) place(notepad, { x: 0, y: 0, w: W, h: H });
  else if (small) place(notepad, { x: 0, y: Math.round(H * 0.4), w: W, h: H - Math.round(H * 0.4) });
  else if (snap) place(notepad, { x: W - gap - sideW, y: gap, w: sideW, h: inner });
  else { const w = Math.min(420, W - 2 * gap), hh = Math.min(520, inner); place(notepad, { x: W - gap - w, y: H - gap - hh, w, h: hh }); }
}
addEventListener('resize', layout);

/* ───────────────────────── 草稿本 ───────────────────────── */

function setScratchStatus() {
  const busy = scratch.timer || scratch.saving;
  scratchStatus.textContent = scratch.failed ? '未能保存，请稍候再试' : busy ? '正在保存…' : '已保存';
  scratchStatus.classList.toggle('failed', scratch.failed);
  scratchCount.textContent = `${scratchArea.value.length} / ${scratchArea.maxLength > 0 ? scratchArea.maxLength : ''} 字符`;
}
function flushScratch({ keepalive = false } = {}) {
  clearTimeout(scratch.timer); scratch.timer = null;
  if (!scratch.token || scratchArea.value === scratch.saved) { setScratchStatus(); return Promise.resolve(); }
  const text = scratchArea.value, pageToken = scratch.token; scratch.saved = text;
  if (keepalive) {
    // 页面卸载时队列不会继续执行，改用keepalive直接发送最后一次内容。
    const body = JSON.stringify({ command_id: uuid(), page_token: pageToken, action: 'scratchpad', client: client(), text });
    fetch(`${endpoint}/commands`, { method: 'POST', keepalive: true, body, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }).catch(() => {});
    return Promise.resolve();
  }
  scratch.saving++; scratch.failed = false; setScratchStatus();
  return command('scratchpad', { text }, pageToken)
    .catch(problem => { if (scratch.saved === text) scratch.saved = null; scratch.failed = true; showError(problem); throw problem; })
    .finally(() => { scratch.saving--; setScratchStatus(); });
}
scratchArea.addEventListener('input', () => {
  clearTimeout(scratch.timer); scratch.failed = false;
  scratch.timer = setTimeout(function save() { if (!ready) { scratch.timer = setTimeout(save, 200); return; } flushScratch().catch(() => {}); }, 450);
  setScratchStatus();
});
function openNotepad() {
  if (!current?.scratchpad) return;
  notepad.hidden = false; notepad.node.classList.remove('closed');
  restore(notepad); layout(); scratchArea.focus({ preventScroll: true });
}
function closeNotepad() {
  flushScratch().catch(() => {});
  notepad.hidden = true; notepad.minimized = false; notepad.node.classList.add('closed'); notepad.node.classList.remove('active', 'minimized');
  focusWindow(main); layout();
}
function bindScratchpad(view, pageChanged) {
  const options = view.scratchpad;
  if (!options) {
    scratch.token = null; noteButton.hidden = true; // 非任务页没有草稿本
    if (!notepad.hidden) { notepad.hidden = true; notepad.node.classList.add('closed'); notepad.node.classList.remove('active'); }
    layout(); syncTaskbar(); return;
  }
  noteButton.hidden = false; noteButton.title = options.label; noteButton.setAttribute('aria-label', options.label);
  notepad.titleText.textContent = options.label; notepad.node.setAttribute('aria-label', options.label);
  scratchArea.placeholder = options.placeholder; scratchArea.maxLength = options.max_length; scratchArea.setAttribute('aria-label', options.label);
  if (pageChanged || scratch.token !== view.page_token) {
    // 按单元读取对应草稿；用value赋值，纯文本不作HTML解析。
    scratchArea.value = options.text ?? ''; scratch.saved = scratchArea.value; scratch.token = view.page_token; scratch.failed = false;
  }
  if (notepad.hidden) notepad.node.classList.add('closed');
  setScratchStatus(); syncTaskbar();
}

/* ───────────────────────── 呈现工具 ───────────────────────── */

function showError(problem) { const text = problem?.message ?? String(problem ?? ''); errorNode.replaceChildren(); if (text) errorNode.append(icon('error', 16), h('span', { text })); footer.classList.toggle('has-error', Boolean(text)); syncFooter(); }
function syncFooter() { footer.hidden = !actionsNode.childElementCount && !errorNode.textContent; }
const gate = node => { node.disabled = true; gated.push(node); return node; };

// 标题中的全角空格或短前缀冒号只是层级分隔，拆成小标题与主标题，文字不增删。
function splitTitle(title) {
  const text = String(title ?? '');
  let index = text.indexOf('　');
  if (index > 0 && index <= 12) return [text.slice(0, index), text.slice(index + 1).trim()];
  index = text.indexOf('：');
  if (index > 0 && index <= 10 && index < text.length - 1) return [text.slice(0, index), text.slice(index + 1).trim()];
  return ['', text];
}
const LEAD = /^([\p{Script=Han}A-Za-z0-9]{1,6})：(.+)$/su;
const HEADING = /^([\p{Script=Han}A-Za-z0-9]{1,8})：$/u;
function prose(texts, container) {
  for (const raw of texts ?? []) {
    const text = String(raw);
    if (HEADING.test(text)) { container.append(h('h3', { class: 'prose-heading', text: text.slice(0, -1) })); continue; }
    const paragraph = h('p', { class: 'prose' });
    // 原文中的连续空格来自文档换行，呈现为换行。
    const lines = text.split(/ {2,}|\n/);
    lines.forEach((line, index) => {
      const target = lines.length > 1 ? h('span', { class: 'line' }) : paragraph;
      const match = LEAD.exec(line);
      if (match) { target.append(h('span', { class: 'lead', text: match[1] }), h('span', { class: 'lead-text', text: match[2] })); if (!index) paragraph.classList.add('has-lead'); }
      else target.append(line);
      if (target !== paragraph) paragraph.append(target);
    });
    container.append(paragraph);
  }
}
function tableNode(data, cls) {
  const head = h('tr', {}, data.columns.map(name => h('th', { scope: 'col', text: name })));
  const body = data.rows.map(cells => h('tr', {}, cells.map(value => h('td', { text: String(value) }))));
  return h('table', { class: cls }, h('caption', { text: data.caption }), h('thead', {}, head), h('tbody', {}, body));
}
function tables(items, container) {
  // 正文中的表格按文档表格排版：标题＋细线表格，不套卡片。
  // 所有表格都以电子表格文件名呈现（标题＋.xlsx，绿色图标），内容仍直接显示在任务单中。
  for (const data of items ?? []) container.append(h('figure', { class: 'doc-table' },
    h('figcaption', { 'aria-hidden': 'true' }, appIcon('sheet', 20), h('span', { text: /\.xlsx$/i.test(data.caption) ? data.caption : `${data.caption}.xlsx` })),
    h('div', { class: 'table-scroll', tabIndex: 0, role: 'region', 'aria-label': data.caption }, tableNode(data, 'grid'))));
}
async function assets(items, container) {
  // 仅兼容旧快照的图片资料；新材料一律为文本表格。
  for (const asset of items ?? []) {
    const response = await fetch(`${endpoint}/assets/${asset.id}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error('任务表格未能读取，请刷新；若仍失败，请联系实验员。');
    const url = URL.createObjectURL(await response.blob()); urls.push(url);
    const image = h('img', { src: url, alt: asset.label });
    container.append(h('figure', { class: 'doc-table legacy' }, h('figcaption', { text: asset.label }), image));
    await image.decode();
  }
}
function pageHeader(view, { progress = true, tools = [] } = {}) {
  const [eyebrow, title] = splitTitle(view.title);
  const heading = h('h1', { tabIndex: -1, text: title });
  const right = h('div', { class: 'page-tools' }, tools);
  if (view.confirmation_enabled && !['COMPLETED', 'ABORTED'].includes(view.phase)) {
    const check = svg('svg', {class:'icon', width:16, height:16, viewBox:'0 0 24 24', fill:'none', 'aria-hidden':'true'}, svg('path', {d:'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4', stroke:'currentColor', 'stroke-width':2, 'stroke-linecap':'round', 'stroke-linejoin':'round'}));
    right.prepend(h('button', {id:'confirm-message', type:'button', class:'btn subtle read-notice', onclick:confirmMessage}, check, h('span', {text:'已阅读消息'})));
  }
  if (progress) {
    const segments = h('span', { class: 'progress-track', 'aria-hidden': 'true' },
      Array.from({ length: view.stage_count }, (_, i) => h('span', { class: i < view.stage_number - 1 ? 'done' : i === view.stage_number - 1 ? 'now' : '' })));
    right.prepend(h('div', { class: 'progress' }, h('span', { class: 'progress-text', text: `任务组 ${view.stage_number} / ${view.stage_count}` }), segments));
  }
  return h('header', { class: 'page-head' }, h('div', { class: 'page-titles' }, eyebrow ? h('p', { class: 'eyebrow', text: eyebrow }) : null, heading), right);
}
function primary(label, onClick, kind = 'accent') {
  return gate(h('button', { type: 'button', class: `btn ${kind}`, text: label, onclick: onClick }));
}
async function act(button, run, { reenable = true } = {}) {
  button.disabled = true; showError('');
  try { await flushScratch().catch(() => {}); await render(await run()); }
  catch (problem) {
    // 服务端因未查看附件而拒绝时（拒绝仍照常落盘），用附件名给出与任务单一致的提示。
    const unseen = problem.status === 422 && current?.phase === 'UNIT' && current.reveal && !current.reveal.observed;
    showError(unseen ? `请先打开附件“${current.reveal.button_label}”查看，再进行下一步。` : problem);
    if (reenable) button.disabled = false; if (problem.status === 409) await refresh();
  }
}

/* ───────────────────────── 作答表单 ───────────────────────── */

function scaleAnchors(field) {
  // 评价题末尾的“1分（…）7分（…）”移到刻度两端呈现；无法完整识别时保持原题。
  const values = field.options.map(o => o.label);
  if (values.length < 3 || !values.every(v => /^\d+$/.test(v))) return null;
  const pattern = new RegExp(`${values[0]}分（([^）]+)）\\s*${values.at(-1)}分（([^）]+)）\\s*$`, 'u');
  const match = pattern.exec(field.label);
  if (!match) return { label: field.label };
  return { label: field.label.slice(0, match.index).trim(), low: match[1], lowText: `${values[0]}分（${match[1]}）`, highText: `${values.at(-1)}分（${match[2]}）` };
}
function buildField(field, saved) {
  const message = h('p', { class: 'field-error', 'aria-live': 'polite' });
  const id = `field-${field.id}`;
  const scale = field.type === 'single' ? scaleAnchors(field) : null;
  // 候选较多的单选（如排班选人）用下拉框，初始为空；其余选择题用按钮组。
  if (field.type === 'single' && !scale && field.options.length > 5) {
    const select = h('select', { id, name: field.id, class: 'combo', 'aria-label': field.label },
      h('option', { value: '', text: '请选择' }), field.options.map(o => h('option', { value: o.value, text: o.label })));
    select.value = field.options.some(o => o.value === String(saved ?? '')) ? String(saved) : '';
    return h('div', { class: 'field inline', 'data-field': field.id },
      h('label', { for: id, class: 'field-label', text: field.label }), h('div', { class: 'combo-wrap' }, select, icon('chevron', 14, 'combo-arrow')), message);
  }
  if (['multi', 'single'].includes(field.type)) {
    const group = h('fieldset', { class: `field field-${field.type}`, 'data-field': field.id });
    const labels = field.options.map(o => o.label);
    const style = scale ? 'scale' : labels.every(l => l.length <= 6) ? 'chips' : 'list';
    group.append(h('legend', { class: 'field-label', text: scale?.label ?? field.label }));
    if (field.type === 'multi') group.append(h('p', { class: 'field-hint', text: '可多选' }));
    const choices = h('div', { class: `choices ${style}` });
    for (const option of field.options) {
      const input = h('input', { type: field.type === 'multi' ? 'checkbox' : 'radio', name: field.id, value: option.value });
      input.checked = field.type === 'multi' ? Array.isArray(saved) && saved.includes(option.value) : String(saved ?? '') === option.value;
      input.addEventListener('change', () => {
        if (field.type === 'multi' && input.checked && field.exclusive_value) for (const other of group.querySelectorAll('input'))
          if (other !== input && (input.value === field.exclusive_value || other.value === field.exclusive_value)) other.checked = false;
      });
      choices.append(h('label', { class: 'choice' }, input, h('span', { class: 'mark', 'aria-hidden': 'true' }), h('span', { class: 'choice-text', text: option.label })));
    }
    if (style === 'scale') choices.style.setProperty('--n', String(field.options.length));
    group.append(choices);
    if (scale?.low) group.append(h('div', { class: 'scale-anchors' }, h('span', { text: scale.lowText }), h('span', { text: scale.highText })));
    group.append(message);
    return group;
  }
  const input = h('input', { id, name: field.id, class: 'textbox', autocomplete: 'off', maxLength: 40, value: saved ?? '', 'aria-label': field.label });
  // 时间、整数与金额都由服务端统一校验，不用pattern拦截全角数字或各类冒号。
  if (field.type === 'time') input.placeholder = '6:23';
  else if (field.type === 'integer') input.inputMode = 'numeric';
  else if (field.type === 'money') { input.inputMode = 'decimal'; input.placeholder = '0.00'; }
  return h('div', { class: 'field inline', 'data-field': field.id },
    h('label', { for: id, class: 'field-label', text: field.label }), h('div', { class: `textbox-wrap type-${field.type}` }, input), message);
}
function missingFields(form) {
  const values = answer(form);
  return current.fields.filter(field => field.type === 'multi' ? !values[field.id].length : String(values[field.id] ?? '').trim() === '');
}
function markInvalid(form, missing) {
  for (const group of form.querySelectorAll('.field')) {
    const bad = missing.some(field => field.id === group.dataset.field);
    group.classList.toggle('invalid', bad);
    group.querySelector('.field-error').textContent = bad ? (group.querySelector('input[type=radio],input[type=checkbox],select') ? '请选择' : '请填写') : '';
  }
}
function buildForm(view, submitButton) {
  const form = h('form', { id: 'answer-form', class: 'answer-form', noValidate: true });
  for (const field of view.fields) form.append(buildField(field, view.answer[field.id]));
  let lastDraft = JSON.stringify(answer(form)), dirty = false;
  const saveDraft = () => {
    const value = answer(form), text = JSON.stringify(value);
    if (text === lastDraft) return;
    if (!ready) { dirty = true; return; }
    lastDraft = text; command('draft', { answer: value }).catch(showError);
  };
  form.flushDraft = () => { if (dirty) { dirty = false; saveDraft(); } };
  // 每次输入都按顺序保存完整草稿；零值与空值保持不同。
  form.addEventListener('input', saveDraft);
  form.addEventListener('change', event => {
    saveDraft();
    const group = event.target.closest('.field');
    if (group?.classList.contains('invalid')) markInvalid(form, missingFields(form));
  });
  form.addEventListener('input', event => {
    const group = event.target.closest('.field');
    if (group?.classList.contains('invalid')) markInvalid(form, missingFields(form));
  });
  // 用户补全后，及时撤下“未完成”的提示，避免误以为仍有遗漏。
  const settle = () => { if (form.dataset.warned && !missingFields(form).length) { delete form.dataset.warned; showError(''); } };
  form.addEventListener('input', settle); form.addEventListener('change', settle);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitButton.disabled) return;
    const missing = missingFields(form);
    markInvalid(form, missing);
    if (missing.length) {
      form.dataset.warned = '1';
      showError(missing.length === current.fields.length ? '请完成作答后再提交。' : `还有 ${missing.length} 项未完成，请全部作答后再提交。`);
      const first = form.querySelector('.field.invalid');
      first?.scrollIntoView({ block: 'center' }); first?.querySelector('input,select')?.focus({ preventScroll: true });
      return;
    }
    await act(submitButton, () => command('submit', { answer: answer(form) }));
  });
  return form;
}

/* ───────────────────────── 补充资料 ───────────────────────── */

// 附件图标按文件扩展名区分：.xlsx 为表格（绿色），.docx 为文档（蓝色）。
const fileKind = name => /\.(xlsx|xls|csv)$/i.test(name) ? 'sheet' : /\.(docx|doc)$/i.test(name) ? 'doc' : 'file';
function attachment(view) {
  const tile = gate(h('button', { type: 'button', class: 'attachment', 'aria-controls': 'viewer' },
    appIcon(fileKind(view.reveal.button_label), 32), h('span', { class: 'attachment-name', text: view.reveal.button_label })));
  tile.addEventListener('click', () => openAttachment(tile));
  attachmentTile = tile;
  return h('div', { class: 'attachments' }, tile);
}
function fillViewer(reveal) {
  for (const url of urls) URL.revokeObjectURL(url); urls = [];
  viewerContent.replaceChildren();
  // 窗口标题即文件名，与任务单中的附件名一致。
  const title = current.reveal?.button_label ?? reveal.tables?.[0]?.caption ?? '';
  const named = fileKind(title);
  const kind = named !== 'file' ? named : reveal.tables?.length ? 'sheet' : 'doc';
  viewer.titleText.textContent = title; viewer.node.setAttribute('aria-label', title);
  viewer.node.querySelector('.win-icon').replaceChildren(appIcon(kind, 16));
  viewerButton.replaceChildren(appIcon(kind, 24), h('span', { class: 'tb-indicator' }));
  viewerButton.title = title; viewerButton.setAttribute('aria-label', title);
  viewer.node.classList.toggle('sheet-view', Boolean(reveal.tables?.length));
  if (reveal.paragraphs?.length) { const page = h('div', { class: 'viewer-doc' }); prose(reveal.paragraphs, page); viewerContent.append(page); }
  for (const data of reveal.tables ?? []) {
    if (reveal.tables.length > 1) viewerContent.append(h('p', { class: 'sheet-caption', text: data.caption }));
    viewerContent.append(tableNode(data, 'sheet'));
  }
  return assets(reveal.assets, viewerContent);
}
function showViewer() {
  viewer.hidden = false; viewer.node.classList.remove('closed'); viewerButton.hidden = false;
  viewerContent.scrollTop = 0; restore(viewer); focusWindow(viewer); layout();
}
function hideViewer() {
  if (viewer.hidden) return;
  viewer.hidden = true; viewer.minimized = false; setMaximized(viewer, false);
  viewer.node.classList.add('closed'); viewer.node.classList.remove('active', 'minimized'); viewerButton.hidden = true;
  const next = topWindow(); if (next) focusWindow(next); layout(); syncTaskbar();
}
async function openAttachment(tile) {
  if (!viewer.hidden) { restore(viewer); focusWindow(viewer); return; }
  tile.disabled = true; showError('');
  try {
    flushScratch().catch(() => {});
    const view = await command('reveal', { open: true });
    if (view.page_token !== current.page_token || view.phase !== current.phase) { await render(view); return; }
    const ticket = generation; current = view;
    await fillViewer(view.reveal); showViewer();
    // 查看器窗口实际显示并完成绘制后才报告E。
    if (await visiblePaint(ticket, viewer) && !current.reveal.observed) { await command('reveal_displayed'); current.reveal.observed = true; }
  } catch (problem) { showError(problem); if (problem.status === 409) await refresh(); }
  finally { tile.disabled = false; }
}
async function closeViewer() {
  hideViewer();
  if (current?.phase !== 'UNIT' || !current.reveal?.open) return;
  try {
    const view = await command('reveal', { open: false });
    if (view.page_token !== current.page_token || view.phase !== current.phase) await render(view); else current = view;
  } catch (problem) { showError(problem); if (problem.status === 409) await refresh(); }
}

/* ───────────────────────── 各阶段页面 ───────────────────────── */

function unitPage(view) {
  const submit = primary('下一步', null);
  submit.type = 'submit'; submit.setAttribute('form', 'answer-form');
  const tools = [
    view.scratchpad ? h('button', { type: 'button', class: 'btn subtle', onclick: openNotepad }, icon('note', 16), h('span', { text: view.scratchpad.label })) : null,
    view.rest ? restTool(view.rest) : null,
  ];
  const doc = h('article', { class: 'doc' });
  const materials = h('div', { class: 'materials pane', tabIndex: -1 }, doc);
  prose(view.paragraphs, doc);
  const reveal = view.reveal ? attachment(view) : null;
  const answerPane = h('aside', { class: 'answer pane', 'aria-label': '填写' }, h('h2', { class: 'pane-title', text: '填写' }), buildForm(view, submit));
  pageNode.className = 'page page-unit';
  pageNode.append(pageHeader(view, { tools }), h('div', { class: 'unit-grid' }, materials, answerPane));
  actionsNode.append(submit);
  return { doc, reveal };
}
function formPage(view) {
  const submit = primary('下一步', null);
  submit.type = 'submit'; submit.setAttribute('form', 'answer-form');
  pageNode.className = 'page page-form';
  const column = h('div', { class: 'reading' }, pageHeader(view));
  prose(view.paragraphs, column);
  column.append(buildForm(view, submit));
  pageNode.append(h('div', { class: 'scroll-area' }, column));
  actionsNode.append(submit);
}
function readingPage(view, label, { progress = true } = {}) {
  pageNode.className = `page page-reading phase-${view.phase.toLowerCase()}`;
  const card = h('div', { class: 'brief' });
  prose(view.paragraphs, card);
  pageNode.append(h('div', { class: 'scroll-area' }, h('div', { class: 'reading' }, pageHeader(view, { progress }), card)));
  const button = primary(label, () => act(button, () => command('continue')));
  actionsNode.append(button);
}
function statusPage(view, kind) {
  pageNode.className = `page page-status status-${kind}`;
  const heading = h('h1', { tabIndex: -1, text: view.title });
  const box = h('div', { class: 'status' }, h('span', { class: 'status-icon' }, icon(kind, 44)), heading);
  prose(view.paragraphs, box);
  pageNode.append(h('div', { class: 'scroll-area center' }, box));
}
function breakPage(view) {
  pageNode.className = 'page page-break';
  const time = h('span', { class: 'break-time', id: 'countdown' });
  const box = h('div', { class: 'status' }, h('span', { class: 'status-icon' }, icon('coffee', 44)), h('h1', { tabIndex: -1, text: view.title }), h('div', { class: 'break-clock' }, time));
  pageNode.append(h('div', { class: 'scroll-area center' }, box));
  if (view.can_skip_break) {
    const skip = primary('跳过休息', () => act(skip, () => command('skip_break')), 'standard');
    skip.id = 'skip-break'; actionsNode.append(skip);
  }
  const next = primary('开始下一任务', () => act(next, () => command('continue')));
  next.id = 'continue-button'; actionsNode.append(next);
  breakClock = { remaining: view.remaining_ms, origin: performance.now(), running: view.break_countdown_started };
  tickBreak();
}
function tickBreak() {
  if (current?.phase !== 'BREAK' || !breakClock) return;
  const remaining = Math.max(0, breakClock.remaining - (breakClock.running ? performance.now() - breakClock.origin : 0));
  const seconds = Math.ceil(remaining / 1000);
  const time = document.querySelector('#countdown');
  if (time) time.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const button = document.querySelector('#continue-button');
  if (button && ready && !pending) button.disabled = !breakClock.running || remaining > 0;
}

// 任务栏右下角的时钟固定显示当前任务组说明卡中的情景时间，全程不走动。
function sceneClock(view) {
  const clock = document.querySelector('#clock'), scene = view.scene_time;
  const visible = Boolean(scene);
  clock.hidden = !visible;
  if (!visible) return;
  document.querySelector('#clock-time').textContent = scene.time;
  document.querySelector('#clock-date').textContent = scene.date;
  clock.title = `${scene.date} ${scene.time}`;
  // 情景时间切换到新的预设时间时，闪烁提示一次；同一时间刷新页面不重复提示。
  const value = `${scene.date} ${scene.time}`, key = `a5-scene-clock:${sessionId}`;
  let previous = null; try { previous = sessionStorage.getItem(key); sessionStorage.setItem(key, value); } catch {}
  if (previous !== value) { clock.classList.remove('flash'); void clock.offsetWidth; clock.classList.add('flash'); clearTimeout(clock.flashTimer); clock.flashTimer = setTimeout(() => clock.classList.remove('flash'), 3400); }
}
function debugTray(view) {
  tray.replaceChildren();
  if (!view.is_debug) return;
  const select = h('select', { id: 'debug-target', required: true }, h('option', { value: '', text: '请选择跳转目标' }), view.debug_targets.map(t => h('option', { value: t.id, text: t.label })));
  const go = gate(h('button', { type: 'submit', class: 'btn accent', text: '跳转' }));
  const form = h('form', { id: 'debug-navigation', class: 'flyout', hidden: true },
    h('label', { for: 'debug-target', class: 'flyout-title', text: '调试测试者：跳转页面' }), select, h('div', { class: 'flyout-actions' }, go));
  const toggle = h('button', { type: 'button', class: 'tray-btn', 'aria-expanded': 'false', 'aria-controls': 'debug-navigation' }, icon('code', 16), h('span', { text: '调试' }));
  toggle.addEventListener('click', () => { form.hidden = !form.hidden; toggle.setAttribute('aria-expanded', String(!form.hidden)); if (!form.hidden) select.focus(); });
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!select.value) { select.focus(); return; }
    act(go, () => command('jump', { target: select.value }));
  });
  tray.append(toggle, form);
}

/* ───────────────────────── 第二单元自主休息 ───────────────────────── */

// 休息按钮外观全程不变（不禁用、不换样式），点击结果完全由服务端决定，避免按钮本身成为休息提示。
// 休息页只是覆盖在桌面上的遮罩：工作台、作答表单与草稿本保持原状，结束后原样露出。
let restScreen = null, restBusy = false, restNudged = 0;
const restReported = new Set(), reminderShown = new Set(), reminderReported = new Set();
const COVERING = ['requested', 'resting'];
const restTag = (rest, step) => `${current?.page_token}|${rest.key}|${step}`;

function restTool(rest) {
  const button = h('button', { type: 'button', id: 'rest-button', class: 'btn subtle', onclick: clickRest }, icon('coffee', 16), h('span', { text: rest.button_label }));
  return h('span', { id: 'rest-tool', class: 'rest-tool' }, button);
}
async function clickRest() {
  // 先把草稿本与作答草稿排进串行队列，再发送点击；休息开始后服务端不再接受草稿。
  flushScratch().catch(() => {});
  document.querySelector('#answer-form')?.flushDraft?.();
  try { await adopt(await command('rest_click')); }
  catch (problem) { showError(problem); if (problem.status === 409) await refresh(); }
}
/** 命令返回的新view：切页则整体渲染，否则只更新休息与确认状态。 */
async function adopt(view) {
  if (!current || view.page_token !== current.page_token || view.phase !== current.phase) { await render(view); return; }
  current.message_confirmation = view.message_confirmation;
  applyRest(view.rest);
}
function applyRest(rest) {
  if (!current) return;
  current.rest = rest ?? null;
  const covering = Boolean(rest) && current.phase !== 'PAUSED' && COVERING.includes(rest.state);
  if (covering) showRestScreen(rest); else hideRestScreen();
  restClock = covering ? { remaining: rest.remaining_ms ?? rest.duration_ms, origin: performance.now(), running: rest.state === 'resting' && rest.countdown_started } : null;
  tickRest();
  showRestFeedback(rest?.feedback);
  if (ready) reportRest();
}
function showRestScreen(rest) {
  const signature = JSON.stringify([rest.key, rest.title, rest.paragraphs, rest.show_countdown]);
  if (restScreen?.dataset.sig === signature) return;
  const fresh = !restScreen;
  restScreen?.remove();
  const box = h('div', { class: 'status' }, h('span', { class: 'status-icon' }, icon('coffee', 44)), h('h1', { id: 'rest-title', tabIndex: -1, text: rest.title }));
  if (rest.show_countdown) box.append(h('div', { class: 'break-clock' }, h('span', { class: 'break-time', id: 'rest-countdown' })));
  prose(rest.paragraphs, box);
  restScreen = h('div', { class: 'rest-screen', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'rest-title' }, box);
  restScreen.dataset.sig = signature;
  // 遮罩期间桌面窗口与任务栏应用不可操作，避免在看不见的表单里输入或误最小化工作台。
  for (const win of windows) win.node.inert = true;
  taskbarApps.inert = true;
  desktop.append(restScreen);
  if (fresh) restScreen.querySelector('h1').focus({ preventScroll: true });
}
function hideRestScreen() {
  if (!restScreen) return;
  restScreen.remove(); restScreen = null;
  for (const win of windows) win.node.inert = false;
  taskbarApps.inert = false;
  if (document.activeElement === document.body) pageNode.querySelector('h1')?.focus({ preventScroll: true });
}
function tickRest() {
  if (!restClock || !restScreen) return;
  const remaining = Math.max(0, restClock.remaining - (restClock.running ? performance.now() - restClock.origin : 0));
  const time = restScreen.querySelector('#rest-countdown');
  if (time) { const seconds = Math.ceil(remaining / 1000); time.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; }
  // 本地倒计时到零后尽快读取最新状态，不等下一次轮询。
  if (restClock.running && remaining <= 0 && !pending && performance.now() - restNudged > 800) {
    restNudged = performance.now();
    api().then(adopt).catch(() => {});
  }
}
function showRestFeedback(feedback) {
  if (!feedback?.id) return;
  // 同一反馈只显示一次；刷新页面后不重复出现。
  const key = `a5-rest-feedback:${sessionId}`;
  let previous = null; try { previous = sessionStorage.getItem(key); sessionStorage.setItem(key, feedback.id); } catch {}
  if (previous === feedback.id) return;
  const tool = document.querySelector('#rest-tool');
  if (!tool) return;
  tool.querySelector('.rest-tip')?.remove();
  const tip = h('span', { class: 'rest-tip', role: 'status', text: feedback.text });
  tool.append(tip);
  setTimeout(() => tip.remove(), 3000);
}
async function overlayPaint(ticket, node) {
  // 与visiblePaint相同的判定：文档可见，再等两帧绘制。
  while (document.visibilityState !== 'visible') {
    await new Promise(resolve => document.addEventListener('visibilitychange', resolve, { once: true }));
    if (ticket !== generation || restScreen !== node) return false;
  }
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return ticket === generation && restScreen === node && document.visibilityState === 'visible';
}
/** 补报休息页可见、回到任务页可见及提醒语显示；失败时由下一次轮询重试。 */
async function reportRest() {
  const rest = current?.rest;
  if (!ready || !rest) return;
  showReminder(rest.reminder);
  if (restBusy) return;
  const ticket = generation;
  let tag = null;
  restBusy = true;
  try {
    if (rest.state === 'requested' && restScreen && !restReported.has(tag = restTag(rest, 'shown'))) {
      restReported.add(tag);
      if (await overlayPaint(ticket, restScreen)) await adopt(await command('rest_displayed'));
      else restReported.delete(tag);
    } else if (rest.state === 'returning' && !restScreen && !restReported.has(tag = restTag(rest, 'back'))) {
      restReported.add(tag);
      if (await visiblePaint(ticket) && !restScreen) await adopt(await command('rest_return_displayed'));
      else restReported.delete(tag);
    }
  } catch (problem) {
    if (tag) restReported.delete(tag);
    showError(problem); if (problem.status === 409) await refresh();
  } finally { restBusy = false; }
}
async function showReminder(reminder) {
  if (!reminder?.id || reminder.displayed || current?.phase === 'PAUSED') return;
  const id = reminder.id;
  if (reminderShown.has(id)) {
    // 已显示但报告失败：只补报，不再重复显示。
    if (!reminderReported.has(id)) sendReminder(id);
    return;
  }
  reminderShown.add(id);
  while (document.visibilityState !== 'visible') await new Promise(resolve => document.addEventListener('visibilitychange', resolve, { once: true }));
  desktop.querySelector('.rest-reminder')?.remove();
  const note = h('div', { class: 'rest-reminder', role: 'status' },
    h('p', { class: 'rest-reminder-app' }, appIcon('work', 16), h('span', { text: '工作台' })),
    h('p', { class: 'rest-reminder-text', text: reminder.text }));
  desktop.append(note);
  setTimeout(() => note.remove(), reminder.display_ms ?? 5000);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (note.isConnected && document.visibilityState === 'visible') sendReminder(id);
}
function sendReminder(id) {
  reminderReported.add(id);
  command('rest_reminder_displayed', { reminder_id: id })
    .then(view => { if (view.page_token === current?.page_token && view.phase === current?.phase && current.rest && view.rest) current.rest.reminder = view.rest.reminder; })
    .catch(() => reminderReported.delete(id));
}

/* ───────────────────────── 渲染与可见报告 ───────────────────────── */

async function visiblePaint(ticket, win = main) {
  // 文档可见、窗口已打开且未最小化后，再等两帧绘制，才算实际可见。
  while (document.visibilityState !== 'visible' || win.minimized || win.hidden) {
    if (win.hidden) return false;
    await new Promise(resolve => {
      const done = () => { document.removeEventListener('visibilitychange', done); win.node.removeEventListener('restored', done); resolve(); };
      document.addEventListener('visibilitychange', done); win.node.addEventListener('restored', done);
    });
    if (ticket !== generation) return false;
  }
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return ticket === generation && document.visibilityState === 'visible' && !win.minimized && !win.hidden;
}
async function render(view) {
  // 切页前先把上一单元未保存的草稿本内容以原page_token送出。
  flushScratch().catch(() => {});
  const pageChanged = !current || view.page_token !== current.page_token || view.phase !== current.phase;
  current = view; const ticket = ++generation; ready = false; gated = []; breakClock = null;
  for (const url of urls) URL.revokeObjectURL(url); urls = [];
  pageNode.replaceChildren(); actionsNode.replaceChildren(); showError('');
  // 附件窗口只属于当前单元；切页或刷新时先关闭，确保新页面不被遮挡。
  attachmentTile = null; hideViewer();
  // 新页面总是出现在最前、未最小化的工作台中。
  restore(main); focusWindow(main);
  debugTray(view); sceneClock(view);
  let unit = null;
  if (view.tutorial || view.phase === 'UNIT' || view.phase === 'TUTORIAL_REST') unit = unitPage(view);
  else if (view.fields.length) formPage(view);
  else if (view.phase === 'INTRO') readingPage(view, '阅读完毕，继续', { progress: false });
  else if (view.phase === 'CARD') readingPage(view, '开始任务');
  else if (view.phase === 'BREAK') breakPage(view);
  else if (view.phase === 'PAUSED') statusPage(view, 'pause');
  else if (view.phase === 'COMPLETED') statusPage(view, 'check');
  else statusPage(view, 'info');
  renderMessageConfirmation(view);
  syncFooter();
  bindScratchpad(view, pageChanged);
  // 休息遮罩同步建立，刷新时不先露出题目；可见报告等页面就绪后再发。
  applyRest(view.rest);
  if (view.phase === 'PAUSED') return;
  if (unit) {
    await assets(view.assets, unit.doc);
    tables(view.tables, unit.doc);
    if (unit.reveal) unit.doc.append(unit.reveal);
  }
  if (ticket !== generation) return;
  if (await visiblePaint(ticket)) {
    const displayedView = await command('displayed');
    if (view.phase === 'BREAK' && ticket === generation) breakClock = { remaining: displayedView.remaining_ms, origin: performance.now(), running: displayedView.break_countdown_started };
    if (view.reveal?.open && ticket === generation) {
      // 刷新前附件处于打开状态：工作台报告可见之后再恢复附件窗口。
      await fillViewer(view.reveal); showViewer();
      if (!view.reveal.observed && await visiblePaint(ticket, viewer)) { await command('reveal_displayed'); if (current.reveal) current.reveal.observed = true; }
      else if (view.reveal.observed) focusWindow(main);
    }
    if (ticket !== generation) return;
    ready = true;
    for (const button of gated) button.disabled = false;
    if (view.phase === 'BREAK') tickBreak();
    document.querySelector('#answer-form')?.flushDraft?.();
    if (restScreen) restScreen.querySelector('h1')?.focus({ preventScroll: true });
    else if (!notepad.node.contains(document.activeElement) && !viewer.node.contains(document.activeElement)) pageNode.querySelector('h1')?.focus({ preventScroll: true });
    reportRest();
  }
}
async function refresh() { try { await render(await api()); } catch (problem) { showError(problem); } }

function fatal(message) {
  pageNode.className = 'page page-status status-info';
  pageNode.replaceChildren(h('div', { class: 'scroll-area center' }, h('div', { class: 'status' }, h('span', { class: 'status-icon' }, icon('info', 44)), h('h1', { text: message }))));
  actionsNode.replaceChildren(); syncFooter();
}

function renderMessageConfirmation(view) {
  let button = document.querySelector('#confirm-message');
  if(!button && view.confirmation_enabled) {
    const tools=document.querySelector('.page-tools');
    if(tools) { const temp=pageHeader(view); button=temp.querySelector('#confirm-message'); if(button) {const progress=tools.querySelector('.progress');if(progress)progress.after(button);else tools.prepend(button);} }
  }
  if (!button) return;
  button.removeAttribute('title');
  button.disabled = false;
}
async function confirmMessage() {
  // 在任何 await 之前捕获实际点击时刻，空点与快速连续点击同样发送记录。
  const payload={click_id:uuid(),page_token:current?.page_token,visible_request_id:current?.message_confirmation?.request_id??null,client:client()};
  const options={method:'POST',body:JSON.stringify(payload)};
  try {
    let result;
    try {result=await api('/read-notice-click',options);}
    catch(problem){if(!(problem instanceof TypeError))throw problem;result=await api('/read-notice-click',options);}
    const view=result.view;
    if(view.page_token!==current.page_token || view.phase!==current.phase)await render(view);
    else current.message_confirmation=view.message_confirmation;
  }catch(problem){showError(problem);}
}

setInterval(() => { tickBreak(); tickRest(); }, 200);
setInterval(async () => {
  if (!current || pending || document.visibilityState !== 'visible') return;
  try {
    const view = await api();
    renderMessageConfirmation(view); current.message_confirmation = view.message_confirmation;
    // 只有page_token或phase变化才整体切页，避免打断输入法、焦点与草稿本编辑。
    if (view.page_token !== current.page_token || view.phase !== current.phase) await render(view);
    else if (view.phase === 'BREAK') breakClock = { remaining: view.remaining_ms, origin: performance.now(), running: view.break_countdown_started };
    else applyRest(view.rest);
  } catch (problem) { showError(problem); }
}, 1500);
addEventListener('blur', () => { if (current && current.phase !== 'PAUSED') command('blur').catch(() => {}); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushScratch().catch(() => {});
  if (document.visibilityState === 'visible' && current) command('resume').catch(showError);
});
addEventListener('pagehide', () => flushScratch({ keepalive: true }));

layout(); focusWindow(main);
pageNode.className = 'page page-status';
pageNode.append(h('div', { class: 'scroll-area center' }, h('div', { class: 'status loading' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('p', { text: '正在读取任务……' }))));
syncFooter();
if (!sessionId || !token) fatal('请使用实验员提供的被试入口。');
else {
  try { current = await api(); await command('resume'); const first = current; current = undefined; await render(first); }
  catch (problem) { if (!current) fatal(problem.message ?? '请求失败。'); else showError(problem); }
}
