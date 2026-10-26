import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import { loadMaterial } from '../src/tasks.ts';
import { readJson } from '../src/preflight.ts';
import { exportData } from '../src/export.ts';
import { createApp } from '../src/app.ts';
import type { DisplayMode, GlassesAdapter, GlassesEvent, GlassesRequest, ParticipantConfig } from '../src/contracts.ts';

async function fixture(mode: DisplayMode = 'confirm_until_ack') {
  const store = new Store(':memory:'); const epoch = Date.parse('2026-10-20T00:00:00Z'); let clock = epoch, confirms = 0, cancels = 0, rejectConfirm = false;
  const requests: GlassesRequest[] = [];
  let engine: Engine;
  const emit = (kind: GlassesEvent['kind'], request = requests[0], extra = {}) => engine.receiveDeviceEvent({ event_id: randomUUID(), request_id: request.request_id, device_id: 'adb:fixture', kind, device_wall_ms: clock, device_monotonic_ms: clock - epoch, clock_id: 'same-device-clock', error: null, ...extra });
  const adapter: GlassesAdapter = {
    getStatus: () => ({ source: 'device', connected: true, ready: true, busy: false, device_id: 'adb:fixture', device_info: { display_modes: 'legacy_8500,tone_8500,confirm_until_ack', fixed_duration_ms: '8500,11000', app_version: '1.1.4' } }),
    send: async request => { requests.push(request); return { request_id: request.request_id, device_id: request.device_id, source: 'device', status: 'accepted', t_send: new Date(clock).toISOString(), t_ack: new Date(clock).toISOString(), t_display: null, t_hide: null, display_time_source: 'unavailable', error: null }; },
    confirm: async request => { confirms++; if (rejectConfirm) throw new Error('transport_unknown'); emit('confirmed', requests.find(r => r.request_id === request.request_id)!); },
    cancel: async request => { cancels++; const message = requests.find(r => r.request_id === request.request_id)!; emit('failed', message, { error: 'experiment_stopped' }); emit('hidden', message); },
  };
  const material = await loadMaterial(), config = await readJson<ParticipantConfig>('config/participants.pilot.json');
  engine = new Engine(store, adapter, material, config, { wall: () => clock, mono: () => clock });
  const created = engine.create('000', { display_mode: mode }), id = created.session_id;
  const send = (action: string, extra = {}) => engine.command(id, { command_id: randomUUID(), page_token: engine.view(id).page_token, action, client: { visibility_state: 'visible' }, ...extra });
  const trigger = async () => { engine.adminAction(id, 'debug_jump', 'test', 'SH01_U1'); send('displayed'); send('reveal', { open: true }); send('reveal_displayed'); await engine.settle(); };
  return { store, engine, adapter, material, config, created, id, send, trigger, requests, emit, advance: (ms: number) => { clock += ms; }, confirms: () => confirms, cancels: () => cancels, reject: (value: boolean) => { rejectConfirm = value; } };
}

test('策略固定于快照；未绘制不能确认，超11秒仍待确认，重复确认幂等且继续当前任务', async () => {
  const f = await fixture();
  try {
    await f.trigger(); assert.equal(f.requests[0].display_mode, 'confirm_until_ack');
    await assert.rejects(f.engine.confirmMessage(f.id, f.requests[0].request_id), /尚未成功绘制/);
    f.advance(1000); f.emit('drawn'); f.advance(20000);
    assert.equal(f.engine.view(f.id).message_confirmation?.can_confirm, true);
    assert.equal(f.send('submit', { answer: { plans: ['A'] } }).phase, 'UNIT');
    assert.equal(f.engine.session(f.id).state.unit, 1);
    await Promise.all([f.engine.confirmMessage(f.id, f.requests[0].request_id), f.engine.confirmMessage(f.id, f.requests[0].request_id)]);
    await f.engine.confirmMessage(f.id, f.requests[0].request_id);
    assert.equal(f.confirms(), 1);
    assert.equal(f.engine.view(f.id).message_confirmation?.confirmed, true);
    assert.equal(f.store.events(f.id).filter(e => e.event_type === 'message_user_confirmed').length, 1);
    assert.equal(f.engine.session(f.id).snapshot.display_mode, 'confirm_until_ack');
  } finally { await f.engine.settle(); f.store.close(); }
});

test('可进入后续任务，但下一条消息的实际触发被拦截到上一条确认且消失；不会排队补发', async () => {
  const f = await fixture();
  try {
    await f.trigger(); f.emit('drawn');
    f.engine.adminAction(f.id, 'debug_jump', 'test', 'SH02_U1'); f.send('displayed'); f.send('reveal', { open: true }); f.send('reveal_displayed');
    const unit = f.engine.unit(f.engine.session(f.id)); assert.equal(unit.scoring.type, 'exact');
    const answer = unit.scoring.type === 'exact' ? unit.scoring.expected : {};
    assert.throws(() => f.send('submit', { answer }), /确认上一条/);
    await f.engine.confirmMessage(f.id, f.requests[0].request_id); f.advance(8499);
    assert.throws(() => f.send('submit', { answer }), /消失回执/);
    assert.equal(f.requests.length, 1);
    f.advance(1); f.emit('hidden');
    f.send('submit', { answer }); f.send('displayed'); await f.engine.settle();
    assert.equal(f.requests.length, 2); assert.equal(f.requests[1].stage_id, 'SH02');
    await assert.rejects(f.engine.confirmMessage(f.id, 'other-session-request'), /不属于当前会话/);
  } finally { await f.engine.settle(); f.store.close(); }
});

test('确认传输失败保留首次点击；重试仅确认，不重发刺激；停止未确认会话取消显示', async () => {
  const f = await fixture();
  try {
    await f.trigger(); f.emit('drawn'); f.reject(true);
    await assert.rejects(f.engine.confirmMessage(f.id, f.requests[0].request_id), /待核查/);
    assert.equal(f.engine.view(f.id).message_confirmation?.status, 'unknown');
    const clicked = f.store.interventions(f.id)[0].confirmation_requested_at;
    f.advance(600); f.reject(false); await f.engine.confirmMessage(f.id, f.requests[0].request_id);
    assert.equal(f.store.interventions(f.id)[0].confirmation_requested_at, clicked);
    assert.equal(f.requests.length, 1);
    f.engine.adminAction(f.id, 'stop', 'test'); await f.engine.settle();
    assert.equal(f.cancels(), 1); assert.equal(f.store.interventions(f.id)[0].status, 'failed');
    assert.equal(f.engine.presentation(f.id).application_presentation_complete, false);
  } finally { await f.engine.settle(); f.store.close(); }
});

test('提示音失败保留异常，后续 hidden 不覆盖；不支持新策略的旧 APK 拒绝创建', async () => {
  const f = await fixture('tone_8500');
  try {
    await f.trigger(); f.emit('drawn'); f.emit('cue_failed', undefined, { error: 'device_audio_muted' }); f.emit('hidden');
    assert.equal(f.requests[0].display_mode, 'tone_8500');
    assert.equal(f.store.interventions(f.id)[0].status, 'failed');
    assert.equal(f.engine.view(f.id).message_confirmation, null);
    await assert.rejects(f.engine.confirmMessage(f.id, f.requests[0].request_id), /不需要确认/);
    f.engine.adminAction(f.id, 'stop', 'test');
    f.adapter.getStatus = () => ({ source: 'device', connected: true, ready: true, device_id: 'adb:fixture' });
    assert.throws(() => f.engine.create('000', { display_mode: 'tone_8500' }), /更新显示端/);
    f.adapter.getStatus = () => ({ source: 'device', connected: true, ready: true, device_id: 'adb:fixture', device_info: { display_modes: 'legacy_8500,tone_8500,confirm_until_ack', app_version: '1.1.3' } });
    assert.throws(() => f.engine.create('000', { display_mode: 'legacy_8500' }), /1\.1\.3.*不支持11秒固定时长/);
    assert.throws(() => f.engine.create('000', { display_mode: 'invalid' }), /策略无效/);
  } finally { await f.engine.settle(); f.store.close(); }
});

test('导出包含策略、用户/设备确认、实际总时长与确认后时长；跨设备时钟不换算', async () => {
  const f = await fixture(), out = await mkdtemp(join(tmpdir(), 'a5-modes-'));
  try {
    await f.trigger(); f.advance(1000); f.emit('drawn'); f.advance(20000);
    await f.engine.confirmMessage(f.id, f.requests[0].request_id); f.advance(16); f.emit('hidden', f.requests[0], { hide_reason: 'user_confirmed' });
    const files = unzipSync((await exportData(f.engine, [f.id], out)).bytes);
    const csv = strFromU8(files['interventions.csv']).split('\r\n');
    const cells = (line: string) => [...line.replace(/^\uFEFF/, '').matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g)].map(m => (m[1] ?? m[2]).replaceAll('""', '"'));
    const headers = cells(csv[0]), values = cells(csv[1]), row = Object.fromEntries(headers.map((key, i) => [key, values[i]]));
    assert.equal(row.display_mode, 'confirm_until_ack'); assert.equal(row.confirmation_recorded, 'true');
    assert.equal(row.auto_hide_after_ms, ''); assert.equal(row.hide_reason, 'user_confirmed');
    assert.equal(Number(row.device_hidden_monotonic_ms) - Number(row.device_confirmed_monotonic_ms), 16);
    assert.ok(row.device_drawn_wall_ms); assert.ok(row.device_hidden_wall_ms); assert.ok(row.device_confirmed_wall_ms);
    assert.equal(row.device_confirmation_delay_ms, '20000'); assert.equal(row.actual_display_duration_ms, '20016'); assert.equal(row.post_confirmation_duration_ms, '16');
    assert.match(strFromU8(files['sessions.csv']), /display_mode/);
    const snapshots = JSON.parse(strFromU8(files['snapshots.json'])); assert.equal(snapshots[0].snapshot.display_mode, 'confirm_until_ack');
    const message = f.store.interventions(f.id)[0]; message.device_events!.find(e => e.kind === 'hidden')!.clock_id = 'different-boot'; f.store.intervention(message);
    const otherFiles = unzipSync((await exportData(f.engine, [f.id], out)).bytes);
    const otherValues = cells(strFromU8(otherFiles['interventions.csv']).split('\r\n')[1]);
    assert.equal(otherValues[headers.indexOf('actual_display_duration_ms')], '');
    assert.equal(otherValues[headers.indexOf('post_confirmation_duration_ms')], '');
  } finally { await f.engine.settle(); f.store.close(); await rm(out, { recursive: true, force: true }); }
});

test('两种固定策略对通知和主动服务均请求11000ms，按设备事件导出实际时长和自动隐藏原因', async () => {
  for (const mode of ['legacy_8500', 'tone_8500'] as const) {
    const f = await fixture(mode), out = await mkdtemp(join(tmpdir(), 'a5-fixed-11s-'));
    try {
      for (const stage of ['SH01', 'SH03']) {
        f.engine.adminAction(f.id, 'debug_jump', '固定时长校验', `${stage}_U1`);
        f.send('displayed'); f.send('reveal', { open: true }); f.send('reveal_displayed'); await f.engine.settle();
        const request = f.requests.at(-1)!;
        assert.equal(request.duration_ms, 11000);
        assert.equal(request.display_mode ?? 'legacy_8500', mode);
        assert.ok(request.message_id.startsWith(stage === 'SH01' ? 'N' : 'A'));
        // 故意延迟绘制，验证导出以设备drawn而不是发送时刻计算实际显示时长。
        f.advance(5000); f.emit('drawn', request); f.advance(11016);
        f.emit('hidden', request, { hide_reason: 'auto_timeout', display_mode: mode, duration_ms: 11000 });
      }
      const files = unzipSync((await exportData(f.engine, [f.id], out)).bytes);
      const lines = strFromU8(files['interventions.csv']).trim().split('\r\n');
      const cells = (line: string) => [...line.replace(/^\uFEFF/, '').matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g)].map(m => (m[1] ?? m[2]).replaceAll('""', '"'));
      const headers = cells(lines[0]);
      assert.equal(lines.length, 3);
      for (const line of lines.slice(1)) {
        const values = cells(line), row = Object.fromEntries(headers.map((key, i) => [key, values[i]]));
        assert.equal(row.duration_ms, '11000'); assert.equal(row.auto_hide_after_ms, '11000');
        assert.equal(row.hide_reason, 'auto_timeout'); assert.equal(row.actual_display_duration_ms, '11016');
        assert.equal(Number(row.device_hidden_monotonic_ms) - Number(row.device_drawn_monotonic_ms), 11016);
        assert.equal(row.device_confirmed_wall_ms, ''); assert.equal(row.device_confirmed_monotonic_ms, '');
      }
    } finally { await f.engine.settle(); f.store.close(); await rm(out, { recursive: true, force: true }); }
  }
});

test('现有练习通知入口采用对应固定策略和11000ms，等待实际隐藏后才继续', async () => {
  for (const mode of ['legacy_8500', 'tone_8500'] as const) {
    const f = await fixture(mode);
    try {
      // 直接准备练习通知页夹具，不新增正常流程中的教程页或触发入口。
      f.store.tx(() => { const s = f.engine.session(f.id); s.state.phase = 'TUTORIAL_NOTICE'; s.state.page_token = randomUUID(); f.store.save(s); });
      f.send('displayed'); await f.engine.settle();
      assert.equal(f.requests[0].duration_ms, 11000);
      assert.equal(f.requests[0].display_mode ?? 'legacy_8500', mode);
      assert.equal(f.store.interventions(f.id)[0].data_kind, 'tutorial');
      f.emit('drawn'); f.advance(11000);
      assert.throws(() => f.send('continue'), /等待眼镜收起/);
      f.emit('hidden', f.requests[0], { hide_reason: 'auto_timeout' });
      assert.equal(f.send('continue').phase, 'TUTORIAL_CHECK');
    } finally { await f.engine.settle(); f.store.close(); }
  }
});

test('确认 HTTP 接口绑定被试 token，不允许跨会话或伪造确认', async () => {
  const f = await fixture(), server = createApp(f.engine, 'unused');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await f.trigger(); f.emit('drawn');
    const call = (token: string, request_id: unknown) => fetch(`http://127.0.0.1:${port}/api/participant/sessions/${f.id}/confirm-message`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ request_id }) });
    assert.equal((await call('wrong', f.requests[0].request_id)).status, 401);
    assert.equal((await call(f.created.token, null)).status, 422);
    assert.equal((await call(f.created.token, 'foreign')).status, 404);
    assert.equal((await call(f.created.token, f.requests[0].request_id)).status, 200);
    assert.equal(f.confirms(), 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.engine.settle(); f.store.close(); }
});


test('逐通知 JSON 优先；跨到不同策略的任务仍可确认上一条；快照和非法值校验', async () => {
  const f = await fixture();
  try {
    f.engine.adminAction(f.id, 'stop', 'test');
    const config = structuredClone(f.config), p = config.participants[0];
    p.stages.find(a => a.stage_id === 'SH01')!.display_mode = 'confirm_until_ack';
    p.stages.find(a => a.stage_id === 'SH02')!.display_mode = 'tone_8500';
    f.engine.importConfig(config);
    const id = f.engine.create(p.participant_id).session_id;
    const cmd = (action: string, extra = {}) => f.engine.command(id, {command_id:randomUUID(), page_token:f.engine.view(id).page_token, action, client:{visibility_state:'visible'}, ...extra});
    f.engine.adminAction(id, 'debug_jump', 'test', 'SH01_U1');
    cmd('displayed'); cmd('reveal', {open:true}); cmd('reveal_displayed'); await f.engine.settle();
    assert.equal(f.requests[0].display_mode, 'confirm_until_ack'); f.emit('drawn');
    f.engine.adminAction(id, 'debug_jump', 'test', 'SH02_U1'); cmd('displayed'); cmd('reveal', {open:true}); cmd('reveal_displayed');
    assert.equal(f.engine.view(id).display_mode, 'tone_8500');
    assert.equal(f.engine.view(id).message_confirmation?.can_confirm, true);
    assert.equal(f.engine.summary(id).display_mode, 'mixed');
    const u = f.engine.unit(f.engine.session(id)); const answer = u.scoring.type === 'exact' ? u.scoring.expected : {};
    assert.throws(() => cmd('submit', {answer}), /确认上一条/);
    await f.engine.confirmMessage(id, f.requests[0].request_id);
    assert.throws(() => cmd('submit', {answer}), /消失回执/);
    f.emit('hidden'); cmd('submit', {answer}); cmd('displayed'); await f.engine.settle();
    assert.equal(f.requests[1].display_mode, 'tone_8500');
    await assert.rejects(f.engine.confirmMessage(id, f.requests[1].request_id), /不需要确认/);
    p.stages[0].display_mode = 'tone_8500'; f.engine.importConfig(config);
    assert.equal(f.engine.session(id).snapshot.participant.stages[0].display_mode, 'confirm_until_ack');
    const invalid = structuredClone(config); (invalid.participants[0].stages[0] as any).display_mode = 'confirm_8500';
    assert.throws(() => f.engine.importConfig(invalid), /display_mode/);
  } finally { await f.engine.settle(); f.store.close(); }
});


test('确认模式三页教程：先绘制、确认、收到消失才能继续，答错留痕，教程不计正式呈现', async () => {
  const f = await fixture(); const out=await mkdtemp(join(tmpdir(),'a5-tutorial-'));
  try {
    f.engine.adminAction(f.id,'stop','');
    const c=f.engine.create('000',{display_mode:'confirm_until_ack',tutorial_enabled:true}), id=c.session_id;
    const cmd=(action:string,extra={})=>f.engine.command(id,{command_id:randomUUID(),page_token:f.engine.view(id).page_token,action,client:{visibility_state:'visible'},...extra});
    assert.equal(f.engine.view(id).phase,'TUTORIAL_INTRO'); assert.ok(f.engine.view(id).scene_time);
    cmd('displayed');cmd('scratchpad',{text:'练习草稿'});cmd('submit',{answer:{}});
    assert.equal(f.engine.view(id).phase,'TUTORIAL_NOTICE'); cmd('displayed');await f.engine.settle();
    assert.equal(f.requests.length,1);assert.equal(f.requests[0].text,'练习会议安排在二号会议室。');
    assert.throws(()=>cmd('submit',{answer:{}}),/阅读并确认/);f.emit('drawn');
    await f.engine.confirmMessage(id,f.requests[0].request_id);assert.throws(()=>cmd('submit',{answer:{}}),/阅读并确认/);
    f.emit('hidden');cmd('submit',{answer:{}});cmd('displayed');
    assert.equal(f.engine.view(id).phase,'TUTORIAL_CHECK');
    assert.throws(()=>cmd('submit',{answer:{answer:'A'}}),/答案不正确/);
    cmd('submit',{answer:{answer:'B'}});assert.equal(f.engine.view(id).phase,'INTRO');
    assert.equal(f.store.events(id).filter(e=>e.event_type==='tutorial_answer_submitted').length,2);
    assert.equal(f.engine.presentation(id).device_drawn_messages,0);
    const exported=await exportData(f.engine,[id],out); const files=unzipSync(exported.bytes);
    assert.ok(strFromU8(files['tutorial.csv']).includes('tutorial_answer_submitted'));
    assert.ok(strFromU8(files['interventions.csv']).includes('tutorial'));
  } finally {await f.engine.settle();f.store.close();await rm(out,{recursive:true,force:true});}
});

test('无确认策略只有一页工具教程；进行中手动确认通知不改变正式进度与正式统计', async () => {
 const f=await fixture();
 try {
  f.engine.adminAction(f.id,'stop','');const id=f.engine.create('000',{display_mode:'legacy_8500',tutorial_enabled:true}).session_id;
  const cmd=(action:string,extra={})=>f.engine.command(id,{command_id:randomUUID(),page_token:f.engine.view(id).page_token,action,client:{visibility_state:'visible'},...extra});
  cmd('displayed');cmd('submit',{answer:{}});assert.equal(f.engine.view(id).phase,'INTRO');assert.equal(f.requests.length,0);
  const requestId=randomUUID();f.engine.manualNotification(id,requestId,'手动通知','confirm_until_ack');await f.engine.settle();f.emit('drawn');
  assert.equal(f.engine.view(id).confirmation_enabled,true);assert.equal(f.engine.view(id).phase,'INTRO');
  await f.engine.confirmMessage(id,requestId);f.emit('hidden');
  assert.equal(f.engine.presentation(id).device_drawn_messages,0);assert.equal(f.store.interventions(id)[0].data_kind,'manual');
  f.engine.manualNotification(id,requestId,'手动通知','confirm_until_ack');await f.engine.settle();assert.equal(f.requests.length,1);
 }finally{await f.engine.settle();f.store.close();}
});


test('000及主试跳转列表包含教程；按会话快照决定一页或三页，跳回练习不重发旧通知',async()=>{
 const f=await fixture();
 try{
  const targets=f.engine.view(f.id).debug_targets;
  assert.deepEqual(targets.slice(0,3).map(t=>t.id),['TUTORIAL_INTRO','TUTORIAL_NOTICE','TUTORIAL_CHECK']);
  f.send('jump',{target:'TUTORIAL_INTRO'});assert.equal(f.engine.view(f.id).phase,'TUTORIAL_INTRO');
  f.send('jump',{target:'TUTORIAL_NOTICE'});f.send('displayed');await f.engine.settle();assert.equal(f.requests.length,1);
  f.send('jump',{target:'INTRO'});f.send('jump',{target:'TUTORIAL_NOTICE'});f.send('displayed');await f.engine.settle();assert.equal(f.requests.length,1);
  f.engine.adminAction(f.id,'debug_jump','','TUTORIAL_CHECK');assert.equal(f.engine.view(f.id).phase,'TUTORIAL_CHECK');
 }finally{await f.engine.settle();f.store.close();}
 const quiet=await fixture('legacy_8500');
 try{assert.deepEqual(quiet.engine.view(quiet.id).debug_targets.filter(t=>t.id.startsWith('TUTORIAL')).map(t=>t.id),['TUTORIAL_INTRO']);}
 finally{await quiet.engine.settle();quiet.store.close();}
});


test('已阅读按钮每次点击均落盘：空点、未绘制、有效、重复与暂停；重试不重复计数或误确认后来消息',async()=>{
 const f=await fixture(),out=await mkdtemp(join(tmpdir(),'a5-clicks-'));
 try{
  const client={timestamp_iso:'2026-10-20T10:00:00.123Z',monotonic_ms:123.456,time_origin_ms:1000,visibility_state:'visible'};
  const empty={click_id:randomUUID(),page_token:f.engine.view(f.id).page_token,client,visible_request_id:null};
  assert.equal((await f.engine.readNoticeClick(f.id,empty)).click.disposition,'ignored_no_pending');
  await f.trigger();
  assert.equal((await f.engine.readNoticeClick(f.id,{click_id:randomUUID(),client})).click.disposition,'ignored_not_drawn');
  f.emit('drawn');
  await f.engine.readNoticeClick(f.id,empty);assert.equal(f.confirms(),0);
  const click={click_id:randomUUID(),page_token:f.engine.view(f.id).page_token,client};
  await Promise.all([f.engine.readNoticeClick(f.id,click),f.engine.readNoticeClick(f.id,click)]);
  assert.equal(f.confirms(),1);
  assert.equal((await f.engine.readNoticeClick(f.id,{click_id:randomUUID(),client})).click.disposition,'ignored_already_confirmed');
  f.engine.adminAction(f.id,'pause','');assert.equal((await f.engine.readNoticeClick(f.id,{click_id:randomUUID(),client})).click.disposition,'ignored_paused');
  const events=f.store.events(f.id).filter(e=>e.event_type==='notice_read_clicked');assert.equal(events.length,5);
  assert.deepEqual(events[0].payload.client,client);assert.ok(events[0].timestamp_iso);assert.equal(typeof events[0].elapsed_ms,'number');
  await assert.rejects(f.engine.readNoticeClick(f.id,{...click,client:{...client,monotonic_ms:999}}),/同一点击编号/);
  const zip=unzipSync((await exportData(f.engine,[f.id],out)).bytes);const csv=strFromU8(zip['notice_clicks.csv']);assert.ok(csv.includes('ignored_no_pending'));assert.ok(csv.includes('123.456'));
 }finally{await f.engine.settle();f.store.close();await rm(out,{recursive:true,force:true});}
});

test('点击埋点HTTP接口绑定会话token，非法点击不落盘，空点正常记一次',async()=>{
 const f=await fixture(),server=createApp(f.engine,'unused');await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/participant/sessions/${f.id}/read-notice-click`;
 const payload={click_id:randomUUID(),client:{timestamp_iso:'2026-10-20T10:00:00Z',monotonic_ms:1}};
 const call=(token:string,body:unknown)=>fetch(base,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(body)});
 try{
  assert.equal((await call('wrong',payload)).status,401);assert.equal((await call(f.created.token,{})).status,422);
  assert.equal((await call(f.created.token,payload)).status,200);assert.equal((await call(f.created.token,payload)).status,200);
  assert.equal(f.store.events(f.id).filter(e=>e.event_type==='notice_read_clicked').length,1);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.engine.settle();f.store.close();}
});


test('真机未就绪时T0展开/T1提交停在原触发前，恢复后只发送一次，不把丢消息当正常推进',async()=>{
 const f=await fixture('tone_8500');
 try{
  const status=f.adapter.getStatus;
  f.engine.adminAction(f.id,'debug_jump','','SH01_U1');f.send('displayed');
  f.adapter.getStatus=()=>({...status(),ready:false});
  assert.throws(()=>f.send('reveal',{open:true}),/眼镜未就绪/);
  assert.equal(f.engine.view(f.id).reveal?.open,false);assert.equal(f.store.interventions(f.id).length,0);
  f.adapter.getStatus=status;f.send('reveal',{open:true});f.send('reveal_displayed');await f.engine.settle();assert.equal(f.requests.length,1);f.emit('drawn');f.emit('hidden');
  f.engine.adminAction(f.id,'debug_jump','','SH02_U1');f.send('displayed');f.send('reveal',{open:true});f.send('reveal_displayed');
  const unit=f.engine.unit(f.engine.session(f.id)),answer=unit.scoring.type==='exact'?unit.scoring.expected:{};
  f.adapter.getStatus=()=>({...status(),ready:false});assert.throws(()=>f.send('submit',{answer}),/眼镜未就绪/);
  assert.equal(f.engine.session(f.id).state.unit,0);assert.equal(f.requests.length,1);
  f.adapter.getStatus=status;f.send('submit',{answer});f.send('displayed');await f.engine.settle();assert.equal(f.requests.length,2);
 }finally{await f.engine.settle();f.store.close();}
});
