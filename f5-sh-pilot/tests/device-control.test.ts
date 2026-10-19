import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Engine } from '../src/engine.ts';
import { Store } from '../src/store.ts';
import { loadMaterial } from '../src/tasks.ts';
import { readJson } from '../src/preflight.ts';
import { DeviceControl } from '../src/device-control.ts';
import { createApp } from '../src/app.ts';
import type { GlassesAdapter, GlassesEvent, GlassesRequest, ParticipantConfig } from '../src/contracts.ts';

async function fixture() {
  const store = new Store(':memory:');
  let ready = true, busy = false, sends = 0, clock = 20000, overlay = false;
  const calls: string[][] = [];
  const requests: GlassesRequest[] = [];
  const adapter: GlassesAdapter = {
    getStatus: () => ({ source: 'device', connected: true, ready, busy, device_id: 'adb:fixture' }),
    probe: async () => {}, reconnect: async () => { calls.push(['reconnect']); },
    send: async request => {
      sends++; requests.push(request);
      return { request_id: request.request_id, device_id: request.device_id, source: 'device', status: 'accepted', t_send: new Date().toISOString(), t_ack: new Date().toISOString(), t_display: null, t_hide: null, display_time_source: 'unavailable', error: null };
    },
  };
  const engine = new Engine(store, adapter, await loadMaterial(), await readJson<ParticipantConfig>('config/participants.pilot.json'));
  const control = new DeviceControl(engine, { serial: 'fixture', packageName: 'link.ironip.a5.rayneo.localfix', now: () => clock,
    run: async (_file, args) => { calls.push(args); return args.includes('get-state') ? 'device\n' : args.includes('dumpsys') && overlay ? 'mCurrentFocus=Window com.ffalconxr.mercury.launcher\nmFocusedApp=link.ironip.a5.rayneo.localfix' : 'Starting'; } });
  return { store, engine, control, requests, calls, sends: () => sends,
    ready: (value: boolean) => { ready = value; }, busy: (value: boolean) => { busy = value; }, overlay: (value: boolean) => { overlay = value; }, advance: (ms: number) => { clock += ms; } };
}

test('独立测试通知：幂等、双眼事件关联、重启不重发，且不写入实验会话', async () => {
  const f = await fixture();
  try {
    const request_id = randomUUID(), input = { action: 'notify', request_id, text: '测试通知\n中文完整' };
    await f.control.action(input);
    assert.throws(() => f.engine.create('000'), /测试通知/);
    await f.control.action(input);
    assert.equal(f.sends(), 1);
    await assert.rejects(f.control.action({ ...input, text: '不同内容' }), /不同内容/);
    const event = (kind: GlassesEvent['kind']): GlassesEvent => ({ event_id: randomUUID(), request_id, device_id: 'adb:fixture', kind, device_wall_ms: 1000, device_monotonic_ms: 1000, clock_id: 'boot', error: null });
    const drawn = event('drawn'); f.engine.receiveDeviceEvent(drawn); f.engine.receiveDeviceEvent(drawn);
    f.engine.receiveDeviceEvent(event('hidden'));
    assert.equal(f.control.status().debug_notifications[0].events.length, 2);
    assert.equal(f.control.status().debug_notifications[0].status, 'hidden');
    assert.deepEqual(f.store.ids(), []);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM interventions').get()!.n, 0);
    await f.control.close();
    const restored = new DeviceControl(f.engine, { serial: 'fixture' });
    await restored.action(input);
    assert.equal(f.sends(), 1);
    await restored.close();
  } finally { await f.control.close(); f.store.close(); }
});

test('进行中会话拒绝独立通知；忙碌时不抢前台、不重建USB', async () => {
  const f = await fixture();
  try {
    f.engine.create('000');
    await assert.rejects(f.control.action({ action: 'notify', request_id: randomUUID(), text: '测试' }), /结束进行中/);
    f.busy(true); f.ready(false);
    f.control.tick();
    await assert.rejects(f.control.action({ action: 'open' }), /尚未展示结束/);
    await assert.rejects(f.control.action({ action: 'reconnect' }), /尚未展示结束/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.sends(), 0);
  } finally { await f.control.close(); f.store.close(); }
});

test('上位机守护限频恢复并固定目标应用，可关闭；不重放消息', async () => {
  const f = await fixture();
  try {
    f.ready(false); f.control.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(f.calls.some(args => args.includes('KEYCODE_WAKEUP')));
    assert.ok(f.calls.some(args => args.includes('link.ironip.a5.rayneo.localfix/link.ironip.a5.rayneo.MainActivity')));
    const initial = f.calls.length;
    f.control.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, initial);
    f.advance(5001); f.control.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, initial * 2);
    await f.control.action({ action: 'host', enabled: false });
    f.advance(5001); f.control.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, initial * 2);
    await f.control.close();
    const next = new DeviceControl(f.engine, { serial: 'fixture', enabled: false, run: async () => { throw new Error('不应执行'); } });
    next.tick(); await next.close();
    assert.equal(f.sends(), 0);
  } finally { f.store.close(); }
});

test('设备控制API需后台鉴权，拒绝未知操作和不合法通知', async () => {
  const f = await fixture();
  const server = createApp(f.engine, 'secret', '', f.control);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const post = (body: object, authorized = true) => fetch(`http://127.0.0.1:${port}/api/admin/device/control`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: 'Bearer secret' } : {}) }, body: JSON.stringify(body) });
    assert.equal((await post({ action: 'open' }, false)).status, 401);
    assert.equal((await post({ action: 'shell', text: 'arbitrary' })).status, 422);
    assert.equal((await post({ action: 'notify', request_id: randomUUID(), text: '' })).status, 422);
    assert.equal((await post({ action: 'host', enabled: false })).status, 200);
    assert.equal(f.control.status().enabled, false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.control.close(); f.store.close(); }
});

test('只收起覆盖显示应用的系统面板；正常显示时不发送返回键或清屏', async () => {
  const f = await fixture();
  try {
    await f.control.action({ action: 'open' });
    assert.equal(f.calls.some(args => args.includes('android.intent.action.CLOSE_SYSTEM_DIALOGS')), false);
    f.overlay(true);
    await f.control.action({ action: 'open' });
    assert.equal(f.calls.filter(args => args.includes('android.intent.action.CLOSE_SYSTEM_DIALOGS')).length, 1);
    assert.equal(f.calls.some(args => args.includes('KEYCODE_BACK') || args.includes('force-stop')), false);
  } finally { await f.control.close(); f.store.close(); }
});
