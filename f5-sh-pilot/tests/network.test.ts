import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createPortProbe } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { lanAddresses } from '../../scripts/network.mjs';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import { MockGlassesAdapter } from '../src/adapters/mock-glasses.ts';
import { createApp } from '../src/app.ts';
import { loadMaterial } from '../src/tasks.ts';
import { readJson } from '../src/preflight.ts';
import type { ParticipantConfig } from '../src/contracts.ts';
import type { NetworkInterfaceInfo } from 'node:os';

const ipv4 = (address: string, internal = false): NetworkInterfaceInfo => ({ address, internal, family: 'IPv4', netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null });

test('热点地址来自实际网卡：支持 Windows 与 macOS、过滤回环/链路本地/IPv6并降低VPN优先级', () => {
  const result = lanAddresses(5173, {
    'utun8': [ipv4('10.9.0.1')], 'Local Area Connection* 12': [ipv4('192.168.137.1')],
    bridge100: [ipv4('192.168.2.1')], lo0: [ipv4('127.0.0.1', true)],
    en8: [ipv4('169.254.1.3')], duplicate: [ipv4('192.168.2.1')],
  });
  assert.equal(result.length, 3);
  assert.equal(result.at(-1)!.name, 'utun8');
  assert.ok(result.some(item => item.base_url === 'http://192.168.137.1:5173'));
  assert.ok(result.some(item => item.base_url === 'http://192.168.2.1:5173'));
  assert.deepEqual(lanAddresses(5173, {}), []);
});

test('主试直接进入、离线二维码、跨主试页面共享入口、被试连接状态与恢复链接失效', async () => {
  const store = new Store(':memory:');
  const engine = new Engine(store, new MockGlassesAdapter(), await loadMaterial(), await readJson<ParticipantConfig>('config/participants.pilot.json'));
  const server = createApp(engine, '');
  await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (path: string, input: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  try {
    const admin = await fetch(base + '/admin'); assert.equal(admin.status, 200);
    assert.match(await admin.text(), /手机扫码进入主试后台/);
    assert.equal((await fetch(base + '/api/admin/config')).status, 200);
    const network = await (await fetch(base + '/api/admin/network')).json() as { shared: boolean; local_url: string };
    assert.equal(network.shared, true);
    assert.equal(network.local_url, base);
    const response = await post('/api/admin/sessions', { participant_id: 'P01' });
    assert.equal(response.status, 201); const created = await response.json() as { session_id: string; token: string; participant_url: string };
    const path = `/api/admin/sessions/${created.session_id}`;
    let detail = await (await fetch(base + path)).json() as { participant_url: string; connection: { connected: boolean; last_seen_at: string | null } };
    assert.equal(detail.participant_url, created.participant_url);
    assert.equal(detail.connection.connected, false);
    const qr = await fetch(base + '/api/admin/qr?text=' + encodeURIComponent(base + created.participant_url));
    assert.equal(qr.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
    assert.match(await qr.text(), /<svg/);
    assert.equal((await fetch(base + '/api/admin/qr?text=javascript:alert(1)')).status, 422);
    const participant = `/api/participant/sessions/${created.session_id}`;
    assert.equal((await fetch(base + participant)).status, 401);
    const headers = { Authorization: `Bearer ${created.token}` };
    assert.equal((await fetch(base + participant, { headers })).status, 200);
    detail = await (await fetch(base + path)).json() as typeof detail;
    assert.equal(detail.connection.connected, true);
    assert.ok(detail.connection.last_seen_at);
    const recovered = await (await post(path + '/access', {})).json() as { participant_url: string };
    assert.equal(((await (await fetch(base + path)).json()) as { participant_url: string }).participant_url, recovered.participant_url);
    assert.notEqual(recovered.participant_url, created.participant_url);
    assert.equal((await fetch(base + participant, { headers })).status, 401);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await engine.settle(); store.close(); }
});


for (const mode of ['default-mock', 'rayneo-offline', 'rayneo-unconfigured']) {
  test(`无眼镜也能打开服务：${mode}，真机未就绪仅限制创建真机会话`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'a5-offline-'));
    const probe = createPortProbe(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), A5_RUNTIME_DIR: join(directory, 'runtime'), A5_EXPORT_DIR: join(directory, 'exports'),
      A5_ADB_PATH: join(directory, 'missing-adb'), A5_RAYNEO_SERIAL: mode === 'rayneo-offline' ? 'absent-device' : '', A5_RAYNEO_HOST_MODE: 'off' };
    if (mode === 'default-mock') delete env.A5_GLASSES_MODE;
    else env.A5_GLASSES_MODE = 'rayneo';
    const child = spawn(process.execPath, [resolve(import.meta.dirname, '../src/server.ts')], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const exited = once(child, 'exit');
    let output = ''; child.stderr?.on('data', chunk => { output += chunk; });
    const base = `http://127.0.0.1:${port}`;
    try {
      let health: { mock_only: boolean; adapter: { connected: boolean } } | undefined;
      for (let i = 0; i < 100; i++) {
        try { const response = await fetch(base + '/api/health'); if (response.ok) { health = await response.json() as typeof health; break; } } catch { /* 等待服务监听。 */ }
        if (child.exitCode !== null) break;
        await delay(40);
      }
      assert.ok(health, output);
      assert.equal((await fetch(base + '/admin')).status, 200);
      assert.equal((await fetch(base + '/api/admin/config')).status, 200);
      assert.equal(health.mock_only, mode === 'default-mock');
      const created = await fetch(base + '/api/admin/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ participant_id: '000' }) });
      assert.equal(created.status, mode === 'default-mock' ? 201 : 409);
    } finally {
      if (child.connected) child.send({ type: 'a5:shutdown' });
      try { await Promise.race([exited, delay(5000, undefined, { ref: false }).then(() => { throw new Error('服务退出超时'); })]); }
      finally { if (child.exitCode === null) { child.kill('SIGKILL'); await exited; } await rm(directory, { recursive: true, force: true }); }
    }
  });
}
