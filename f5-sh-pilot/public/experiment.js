const params = new URLSearchParams(location.hash.slice(1));
const sessionId = params.get('session'), token = params.get('token');
const endpoint = `/api/participant/sessions/${sessionId}`;
const root = document.querySelector('#experiment'), error = document.querySelector('#error');
let current, generation = 0, queue = Promise.resolve(), pending = 0, urls = [], breakClock;
const client = () => ({ timestamp_iso: new Date().toISOString(), monotonic_ms: performance.now(), time_origin_ms: performance.timeOrigin, visibility_state: document.visibilityState, user_agent: navigator.userAgent });
const element = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
const showError = problem => { error.textContent = problem?.message ?? String(problem); };
async function api(path = '', options = {}) {
  const response = await fetch(endpoint + path, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) { const problem = new Error(data.error ?? '请求失败。'); problem.status = response.status; throw problem; }
  return data;
}
function command(action, extra = {}) {
  const payload = { command_id: crypto.randomUUID(), page_token: current.page_token, action, client: client(), ...extra };
  pending++;
  const operation = queue.then(async () => {
    const options = { method: 'POST', body: JSON.stringify(payload) };
    try { return await api('/commands', options); }
    catch (problem) {
      // 只对网络中断重试同一个操作ID，防止提交已落盘但响应丢失导致重复。
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
async function visiblePaint(ticket) {
  if (document.visibilityState !== 'visible') await new Promise(resolve => {
    const listener = () => { if (document.visibilityState === 'visible' || generation !== ticket) { document.removeEventListener('visibilitychange', listener); resolve(); } };
    document.addEventListener('visibilitychange', listener);
  });
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return ticket === generation && document.visibilityState === 'visible';
}
async function assets(items, container) {
  for (const asset of items) {
    const response = await fetch(`${endpoint}/assets/${asset.id}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error('任务表格未能读取，请刷新；若仍失败，请联系实验员。');
    const url = URL.createObjectURL(await response.blob()); urls.push(url);
    const figure = element('figure'), caption = element('figcaption', asset.label), image = element('img');
    image.src = url; image.alt = asset.label; figure.append(caption, image); container.append(figure); await image.decode();
  }
}
function tables(items, container) {
  for (const data of items ?? []) {
    const wrapper = element('div'); wrapper.className = 'scroll';
    const table = element('table'), caption = element('caption', data.caption), head = element('thead'), header = element('tr');
    for (const name of data.columns) { const th = element('th', name); th.scope = 'col'; header.append(th); }
    head.append(header); const body = element('tbody');
    for (const cells of data.rows) { const row = element('tr'); for (const value of cells) row.append(element('td', String(value))); body.append(row); }
    table.append(caption, head, body); wrapper.append(table); container.append(wrapper);
  }
}
function debugNavigation(view) {
  if (!view.is_debug) return;
  const form = element('form'); form.id = 'debug-navigation';
  const label = element('label', '调试测试者000：跳转页面'); label.htmlFor = 'debug-target';
  const select = element('select'); select.id = 'debug-target'; select.required = true; select.add(new Option('请选择跳转目标', ''));
  for (const target of view.debug_targets) select.add(new Option(target.label, target.id));
  const button = element('button', '跳转'); button.type = 'submit'; button.disabled = true;
  form.append(label, select, button); root.append(form);
  form.addEventListener('submit', async event => {
    event.preventDefault(); button.disabled = true;
    try { await render(await command('jump', { target: select.value })); } catch (problem) { showError(problem); button.disabled = false; }
  });
}
function scratchpad(options) {
  if (!options) return;
  const details = element('details'); details.id = 'scratchpad'; details.append(element('summary', options.label));
  const textarea = element('textarea'); textarea.rows = 6; textarea.value = options.text; textarea.maxLength = options.max_length;
  textarea.placeholder = options.placeholder; textarea.setAttribute('aria-label', options.label); details.append(textarea); root.append(details);
  textarea.addEventListener('input', () => { command('scratchpad', { text: textarea.value }).catch(showError); });
}
function buildForm(view, container) {
  const form = element('form'); form.id = 'answer-form';
  for (const field of view.fields) {
    const group = element('fieldset'); group.append(element('legend', field.label));
    const saved = view.answer[field.id];
    if (['multi', 'single'].includes(field.type)) {
      for (const option of field.options) {
        const label = element('label'), input = element('input'); input.name = field.id; input.value = option.value;
        input.type = field.type === 'multi' ? 'checkbox' : 'radio';
        input.checked = field.type === 'multi' ? Array.isArray(saved) && saved.includes(option.value) : String(saved ?? '') === option.value;
        if (field.type === 'single') input.required = true;
        input.addEventListener('change', () => {
          if (field.type === 'multi') {
            const inputs = [...group.querySelectorAll('input')];
            if (input.checked && field.exclusive_value) for (const other of inputs) if (other !== input && (input.value === field.exclusive_value || other.value === field.exclusive_value)) other.checked = false;
            inputs[0].setCustomValidity(inputs.some(i => i.checked) ? '' : '请至少选择一项。');
          }
        });
        label.append(input, document.createTextNode(option.label)); group.append(label);
      }
      if (field.type === 'multi') group.querySelector('input').setCustomValidity(Array.isArray(saved) && saved.length ? '' : '请至少选择一项。');
    } else {
      const input = element('input'); input.name = field.id; input.required = true; input.value = saved ?? ''; input.autocomplete = 'off'; input.maxLength = 40;
      input.setAttribute('aria-label', field.label);
      if (field.type === 'time') { input.placeholder = '6:23 或 6：23'; }
      else if (field.type === 'integer') { input.inputMode = 'numeric'; input.pattern = '\\d+'; }
      else if (field.type === 'money') { input.inputMode = 'decimal'; input.placeholder = '0.00'; input.pattern = '\\d+(\\.\\d{1,2})?'; }
      group.append(input);
    }
    form.append(group);
  }
  const submit = element('button', '提交'); submit.type = 'submit'; submit.disabled = true; form.append(submit);
  // input事件先保存完整草稿，再由队列处理提交；零值与空值保持不同。
  form.addEventListener('input', () => { command('draft', { answer: answer(form) }).catch(showError); });
  form.addEventListener('change', () => { command('draft', { answer: answer(form) }).catch(showError); });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!form.reportValidity()) return;
    error.textContent = ''; submit.disabled = true;
    try { await render(await command('submit', { answer: answer(form) })); }
    catch (problem) { showError(problem); submit.disabled = false; if (problem.status === 409) await refresh(); }
  });
  container.append(form); return submit;
}
function updateBreak(view) {
  breakClock = { remaining: view.remaining_ms, origin: performance.now() };
}
async function render(view) {
  current = view; const ticket = ++generation; error.textContent = '';
  for (const url of urls) URL.revokeObjectURL(url); urls = [];
  root.replaceChildren(); root.append(element('h1', view.title));
  document.querySelector('#progress').textContent = ['INTRO', 'COMPLETED', 'ABORTED'].includes(view.phase) ? '' : `任务组 ${view.stage_number} / ${view.stage_count}`;
  for (const text of view.paragraphs) root.append(element('p', text));
  if (view.phase === 'PAUSED') return;
  debugNavigation(view);
  await assets(view.assets, root);
  tables(view.tables, root);
  if (ticket !== generation) return;
  if (view.reveal) {
    const button = element('button', view.reveal.open ? '收起补充资料' : view.reveal.button_label); button.type = 'button'; button.disabled = true;
    button.setAttribute('aria-expanded', String(view.reveal.open)); root.append(button);
    button.addEventListener('click', async () => { button.disabled = true; try { await render(await command('reveal', { open: !current.reveal.open })); } catch (problem) { showError(problem); button.disabled = false; } });
    const details = element('section'); details.setAttribute('aria-label', '补充资料'); root.append(details);
    if (view.reveal.open) { for (const text of view.reveal.paragraphs) details.append(element('p', text)); await assets(view.reveal.assets, details); tables(view.reveal.tables, details); }
  }
  let primary;
  if (view.fields.length) { primary = buildForm(view, root); scratchpad(view.scratchpad); }
  else if (['INTRO', 'CARD', 'BREAK'].includes(view.phase)) {
    if (view.phase === 'BREAK') { const timer = element('p'); timer.id = 'countdown'; root.append(timer); updateBreak(view); }
    primary = element('button', view.phase === 'INTRO' ? '阅读完毕，继续' : view.phase === 'CARD' ? '开始任务' : '继续'); primary.type = 'button'; primary.disabled = true; root.append(primary);
    primary.id = 'continue-button';
    primary.addEventListener('click', async () => { primary.disabled = true; try { await render(await command('continue')); } catch (problem) { showError(problem); if (view.phase !== 'BREAK') primary.disabled = false; } });
    if (view.phase === 'BREAK' && view.can_skip_break) {
      const skip = element('button', '跳过休息'); skip.id = 'skip-break'; skip.type = 'button'; skip.disabled = true; root.append(skip);
      skip.addEventListener('click', async () => { skip.disabled = true; try { await render(await command('skip_break')); } catch (problem) { showError(problem); skip.disabled = false; } });
    }
  }
  if (await visiblePaint(ticket)) {
    await command('displayed');
    if (view.reveal?.open && !view.reveal.observed) { await command('reveal_displayed'); if (current.reveal) current.reveal.observed = true; }
    if (ticket !== generation) return;
    for (const button of root.querySelectorAll('button')) button.disabled = false;
    if (view.phase === 'BREAK' && primary) primary.disabled = view.remaining_ms > 0;
    root.querySelector('h1').tabIndex = -1; root.querySelector('h1').focus();
  }
}
async function refresh() { try { await render(await api()); } catch (problem) { showError(problem); } }
setInterval(() => {
  if (current?.phase !== 'BREAK' || !breakClock) return;
  const remaining = Math.max(0, breakClock.remaining - (performance.now() - breakClock.origin));
  const node = root.querySelector('#countdown'); if (node) node.textContent = `剩余 ${Math.ceil(remaining / 1000)} 秒`;
  const button = root.querySelector('#continue-button'); if (button && !pending) button.disabled = remaining > 0;
}, 200);
setInterval(async () => {
  if (!current || pending || document.visibilityState !== 'visible') return;
  try {
    const view = await api();
    if (view.page_token !== current.page_token || view.phase !== current.phase) await render(view);
    else if (view.phase === 'BREAK') updateBreak(view);
  } catch (problem) { showError(problem); }
}, 1500);
addEventListener('blur', () => { if (current && current.phase !== 'PAUSED') command('blur').catch(() => {}); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && current) command('resume').catch(showError); });
if (!sessionId || !token) { root.textContent = '请使用实验员提供的被试入口。'; }
else {
  try { current = await api(); await command('resume'); await render(current); }
  catch (problem) { showError(problem); }
}
