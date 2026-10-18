const params = new URLSearchParams(location.hash.slice(1));
if (params.get('key')) sessionStorage.setItem('a5-admin-key', params.get('key'));
history.replaceState(null, '', location.pathname);
const key = sessionStorage.getItem('a5-admin-key');
const $ = selector => document.querySelector(selector);
let config, selected, debugParticipant;
const text = (node, value) => { node.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };
function fail(error) { text($('#error'), error.message ?? error); }
async function api(path, data) {
  const response = await fetch('/api/admin/' + path, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  if (!response.ok) { const problem = await response.json(); throw new Error(problem.error); }
  if (path.startsWith('export')) {
    const url = URL.createObjectURL(await response.blob()), link = document.createElement('a'); link.href = url; link.download = `a5-export-${Date.now()}.zip`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); return;
  }
  return response.json();
}
function access(url) {
  const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = '打开被试界面';
  $('#access').replaceChildren(link, document.createTextNode('（请在被试使用的屏幕打开；恢复入口会使旧入口失效）'));
}
async function loadConfig() {
  const data = await api('config'); config = data.config; debugParticipant = data.debug_participant;
  const previous = $('#participant').value; $('#participant').replaceChildren(new Option('请选择', ''));
  if (debugParticipant) $('#participant').add(new Option('000 / 调试测试者（复制001）', '000'));
  for (const p of config.participants) $('#participant').add(new Option(`${p.participant_id} / ${p.version_label ?? ''}`, p.participant_id));
  $('#participant').value = previous; assignment();
  $('#prompts').replaceChildren(); for (const prompt of data.interview_prompts) { const item = document.createElement('li'); item.textContent = prompt; $('#prompts').append(item); }
}
function assignment() { const p = $('#participant').value === '000' ? debugParticipant : config?.participants.find(p => p.participant_id === $('#participant').value); text($('#assignment'), p ? p.stages : '选择被试后显示预分配条件。'); }
const phases = { INTRO:'情景导入', CARD:'说明卡', UNIT:'主任务', COMPREHENSION:'消息理解题', RATINGS:'四项评价', BREAK:'休息', COMPLETED:'已完成', ABORTED:'已结束' };
function statePanel(data) {
  const s = data.summary;
  const values = [ ['被试', `${s.participant_id}${s.is_debug ? '（调试，复制001）' : ''}`], ['当前阶段', s.paused ? '已暂停' : phases[s.phase] ?? s.phase],
    ['当前内容', s.current_title], ['任务位置', `${s.stage_id} / U${s.unit}`], ['答题进度', `${s.answered_fields} / ${s.total_fields}`],
    ['补充资料', s.reveal_observed === null ? '不适用' : s.reveal_observed ? '已展示' : '未展示'], ['消息状态', s.message_status],
    ['剩余休息', s.remaining_ms === null ? '不适用' : `${Math.ceil(s.remaining_ms / 1000)}秒`], ['最近事件', `${s.last_event_type ?? ''} ${s.last_event_at ?? ''}`] ];
  $('#state-values').replaceChildren();
  for (const [label, value] of values) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; $('#state-values').append(dt, dd); }
  for (const button of $('#control').querySelectorAll('button')) button.disabled = !s.available_actions.includes(button.value);
  $('#admin-debug').hidden = !s.is_debug;
  const targets = data.view.debug_targets ?? [], signature = targets.map(t => t.id).join(',');
  if ($('#admin-debug-target').dataset.targets !== signature) {
    $('#admin-debug-target').replaceChildren(); for (const t of targets) $('#admin-debug-target').add(new Option(t.label, t.id));
    $('#admin-debug-target').dataset.targets = signature;
  }
}
$('#participant').addEventListener('change', assignment);
async function select(id) {
  selected = id; $('#selected').hidden = false;
  const data = await api(`sessions/${id}`); text($('#selected-title'), `被试 ${data.summary.participant_id} 的会话`);
  text($('#details'), { ...data.summary, assignment: data.assignment.stages, interventions: data.interventions });
  statePanel(data);
  const notes = await api(`sessions/${id}/notes`); text($('#notes'), notes.notes.map(e => ({ time: e.timestamp_iso, ...e.payload })));
}
async function refresh() {
  const data = await api('sessions'); $('#sessions').replaceChildren();
  for (const s of data.sessions) {
    const row = document.createElement('tr');
    for (const value of [s.is_debug ? `${s.participant_id}（调试）` : s.participant_id, phases[s.phase] ?? s.phase, `${s.stage_id} / U${s.unit}`, s.paused ? '已暂停' : s.status, s.attention.join('；') || '无（Mock）']) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
    const cell = document.createElement('td'), button = document.createElement('button'); button.type = 'button'; button.textContent = '查看'; button.onclick = () => select(s.session_id).catch(fail); cell.append(button); row.append(cell); $('#sessions').append(row);
  }
  if (selected) await select(selected);
}
$('#start').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; text($('#error'), '');
  try { const created = await api('sessions', { participant_id: $('#participant').value }); access(created.participant_url); await select(created.session_id); await refresh(); }
  catch (error) { fail(error); } finally { button.disabled = false; }
});
$('#import').addEventListener('submit', async event => {
  event.preventDefault(); try { const file = $('#config').files[0]; await api('config', JSON.parse(await file.text())); await loadConfig(); text($('#notice'), '配置校验通过并已导入。已开始会话保持原快照。'); } catch (error) { fail(error); }
});
$('#preflight').onclick = async () => { try { text($('#check-result'), await api('preflight')); } catch (error) { fail(error); } };
$('#export-all').onclick = () => api('export').catch(fail);
$('#export-one').onclick = () => selected && api(`export?session_id=${selected}`).catch(fail);
$('#recover').onclick = async () => { try { const result = await api(`sessions/${selected}/access`, {}); access(result.participant_url); } catch (error) { fail(error); } };
$('#control').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; if (!button) return; button.disabled = true;
  try { await api(`sessions/${selected}/control`, { action: button.value, reason: $('#reason').value, target: $('#admin-debug-target').value }); text($('#notice'), '干预已记录。'); await refresh(); } catch (error) { fail(error); await select(selected).catch(fail); }
});
$('#note').addEventListener('submit', async event => {
  event.preventDefault(); try { await api(`sessions/${selected}/notes`, { category: $('#category').value, stage_id: $('#note-stage').value || null, text: $('#note-text').value }); $('#note-text').value = ''; text($('#notice'), '备注已追加保存。'); await select(selected); } catch (error) { fail(error); }
});
$('#logs').onclick = async () => { try { text($('#events'), await api(`sessions/${selected}/events`)); } catch (error) { fail(error); } };
if (!key) fail(new Error('请打开运行终端显示的完整实验员后台链接。'));
else { try { await loadConfig(); await refresh(); } catch (error) { fail(error); } }
setInterval(() => { if (key) refresh().catch(fail); }, 2500);
