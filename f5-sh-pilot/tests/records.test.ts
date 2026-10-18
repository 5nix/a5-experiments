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
import { MockGlassesAdapter } from '../src/adapters/mock-glasses.ts';
import { createApp } from '../src/app.ts';
import type { ParticipantConfig } from '../src/contracts.ts';

const material = await loadMaterial();
const config = await readJson<ParticipantConfig>('config/participants.pilot.json');

test('删除记录可恢复且跨重启保留；进行中不可删，已删除记录不可作答或修改，原始数据不抹除', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a5-records-'));
  let store = new Store(join(directory, 'test.sqlite'));
  let engine = new Engine(store, new MockGlassesAdapter(), material, config);
  try {
    const c = engine.create('000');
    const send = (action: string, extra = {}) => engine.command(c.session_id, { command_id: randomUUID(), page_token: engine.view(c.session_id).page_token, action, client: { visibility_state:'visible' }, ...extra });
    assert.ok(!engine.summary(c.session_id).available_actions.includes('delete'));
    assert.throws(() => engine.adminAction(c.session_id, 'delete', '清理预演'), /先结束会话/);
    send('jump', { target:'SH01_U1' }); send('displayed'); send('scratchpad', { text:'保留的草稿' }); send('draft', { answer:{ plans:['A'] } });
    engine.note(c.session_id, 'observation', '保留的观察记录', null);
    engine.adminAction(c.session_id, 'stop', '预演结束');
    const snapshot = structuredClone(engine.session(c.session_id).snapshot);
    const originalEvents = store.events(c.session_id).map(e => e.event_id);
    assert.ok(engine.summary(c.session_id).available_actions.includes('delete'));
    assert.throws(() => engine.adminAction(c.session_id, 'delete', '  '), /填写原因/);
    engine.adminAction(c.session_id, 'delete', '清理预演'); engine.adminAction(c.session_id, 'delete', '重复点击');
    assert.deepEqual(store.ids(), []); assert.deepEqual(store.deletedIds(), [c.session_id]);
    assert.deepEqual(engine.summary(c.session_id).available_actions, ['restore']);
    assert.deepEqual(store.events(c.session_id).slice(0, originalEvents.length).map(e => e.event_id), originalEvents);
    assert.equal(store.events(c.session_id).filter(e => e.event_type === 'session_deleted').length, 1);
    assert.throws(() => engine.authenticate(c.session_id, c.token), /已删除/);
    assert.throws(() => send('jump', { target:'SH05_U2' }), /已删除/);
    assert.throws(() => engine.adminAction(c.session_id, 'debug_jump', '尝试跳题', 'SH05_U2'), /已删除/);
    assert.throws(() => engine.rotateToken(c.session_id), /已删除/);
    assert.throws(() => engine.note(c.session_id, 'observation', '不可修改', null), /已删除/);
    assert.throws(() => store.db.prepare('DELETE FROM events WHERE session_id=?').run(c.session_id), /append-only/);
    await engine.settle(); store.close();
    store = new Store(join(directory, 'test.sqlite')); engine = new Engine(store, new MockGlassesAdapter(), material, config);
    assert.equal(engine.summary(c.session_id).deletion_reason, '清理预演'); assert.deepEqual(store.ids(), []);
    engine.adminAction(c.session_id, 'restore', '恢复预演记录');
    assert.deepEqual(store.ids(), [c.session_id]); assert.deepEqual(store.deletedIds(), []);
    assert.equal(engine.summary(c.session_id).status, 'aborted');
    assert.deepEqual(engine.session(c.session_id).snapshot, snapshot);
    assert.equal(engine.session(c.session_id).state.scratchpads?.SH01_U1, '保留的草稿');
    assert.ok(store.events(c.session_id).some(e => e.event_type === 'note_saved' && e.payload.text === '保留的观察记录'));
    assert.equal(store.events(c.session_id).filter(e => e.event_type === 'session_restored').length, 1);
    assert.throws(() => engine.adminAction(c.session_id, 'restore', '重复恢复'), /无需恢复/);
  } finally { await engine.settle(); store.close(); await rm(directory, { recursive:true, force:true }); }
});

test('HTTP删除/恢复仅后台可用；全部导出含同一被试多次及未完成会话，排除已删除，单次导出隔离', async () => {
  const store = new Store(':memory:'), engine = new Engine(store, new MockGlassesAdapter(), material, config);
  const directory = await mkdtemp(join(tmpdir(), 'a5-records-http-'));
  const server = createApp(engine, 'admin-key', directory); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port:number }).port}`;
  const headers = { Authorization:'Bearer admin-key', 'Content-Type':'application/json' };
  const control = (id: string, action: string, auth = headers) => fetch(`${base}/api/admin/sessions/${id}/control`, { method:'POST', headers:auth, body:JSON.stringify({ action, reason:'软件验收记录操作' }) });
  const manifest = async (response: Response) => JSON.parse(strFromU8(unzipSync(new Uint8Array(await response.arrayBuffer()))['manifest.json']));
  try {
    const first = engine.create('001'); engine.adminAction(first.session_id, 'stop', '第一次预演结束');
    const second = engine.create('001'), debug = engine.create('000'); engine.adminAction(debug.session_id, 'stop', '调试结束');
    assert.equal((await control(debug.session_id, 'delete', { ...headers, Authorization:`Bearer ${debug.token}` })).status, 401);
    assert.equal((await control(second.session_id, 'delete')).status, 409);
    assert.equal((await control(debug.session_id, 'delete')).status, 200);
    const list = await (await fetch(base + '/api/admin/sessions', { headers })).json() as { sessions:{ session_id:string }[]; deleted_sessions:{ session_id:string }[] };
    assert.deepEqual(list.sessions.map(s => s.session_id), [first.session_id, second.session_id]); assert.deepEqual(list.deleted_sessions.map(s => s.session_id), [debug.session_id]);
    const removedAccess = await fetch(`${base}/api/participant/sessions/${debug.session_id}`, { headers:{ Authorization:`Bearer ${debug.token}` } }); assert.equal(removedAccess.status, 410);
    assert.equal((await fetch(`${base}/api/admin/export?session_id=${debug.session_id}`, { headers })).status, 410);
    const all = await manifest(await fetch(base + '/api/admin/export', { headers })); assert.deepEqual(all.session_ids, [first.session_id, second.session_id]); assert.equal(all.row_counts.sessions, 2);
    const single = await manifest(await fetch(`${base}/api/admin/export?session_id=${first.session_id}`, { headers })); assert.deepEqual(single.session_ids, [first.session_id]);
    assert.equal((await control(debug.session_id, 'restore')).status, 200);
    const restored = await manifest(await fetch(base + '/api/admin/export', { headers })); assert.deepEqual(restored.session_ids, [first.session_id, second.session_id, debug.session_id]); assert.deepEqual(restored.debug_session_ids, [debug.session_id]);
    assert.equal(engine.summary(debug.session_id).status, 'aborted'); assert.equal(engine.summary(second.session_id).status, 'active');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await engine.settle(); store.close(); await rm(directory, { recursive:true, force:true }); }
});
