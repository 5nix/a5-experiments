import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import { MockGlassesAdapter } from '../src/adapters/mock-glasses.ts';
import { loadMaterial } from '../src/tasks.ts';
import { readJson, experimentRoot } from '../src/preflight.ts';
import { createApp } from '../src/app.ts';
import { ConfigFiles } from '../src/config-files.ts';
import type { ParticipantConfig } from '../src/contracts.ts';

test('六份通知配置保持28人7组分配，000三种模式均来自文件且为V1列七组', async () => {
  const material = await loadMaterial();
  const original = await readJson<ParticipantConfig>('config/participants.pilot.json');
  const files = new ConfigFiles(join(experimentRoot, 'config/notifications'), material.stimuli);
  const listed = await files.list();
  assert.equal(listed.filter(f => f.valid).length, 6);
  assert.ok(!listed.some(f => f.filename.startsWith('20-participants')));
  for (const mode of ['legacy_8500', 'tone_8500', 'confirm_until_ack']) {
    for (const prefix of ['000', '28-participants']) {
      const cfg = await files.read(`${prefix}.${mode}.json`);
      assert.equal(cfg.participants.length, prefix === '000' ? 0 : 28);
      if (prefix !== '000') assert.deepEqual(cfg.participants.map(p => [p.participant_id, p.stages.map(a => [a.stage_id,a.condition,a.message_id])]), original.participants.map(p => [p.participant_id,p.stages.map(a => [a.stage_id,a.condition,a.message_id])]));
      assert.ok(cfg.participants.every(p => p.stages.length === 7));
      assert.deepEqual(cfg.debug_participant!.stages.map(a => [a.stage_id, a.condition, a.message_id]), [
        ['SH01', 'N-T0', 'N01'], ['SH02', 'N-T1', 'N02'], ['SH03', 'A-T0', 'A03'], ['SH04', 'A-T1', 'A04'],
        ['SH05', 'N-T2', 'N05'], ['SH06', 'A-T2', 'A06'], ['SH07', 'NONE', null],
      ]);
      assert.ok(cfg.debug_participant!.stages.filter(a => a.condition !== 'NONE').every(a => a.display_mode === mode));
      assert.ok(cfg.participants.every(p => p.stages.filter(a => a.condition !== 'NONE').every(a => a.display_mode === mode)));
    }
  }
});

test('文件选择/导入落盘、重名不覆盖、非法文件不导入，创建请求绑定所选文件并固定000快照', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a5-config-files-')), store = new Store(':memory:');
  const material = await loadMaterial(), initial = await readJson<ParticipantConfig>('config/participants.pilot.json');
  const engine = new Engine(store, new MockGlassesAdapter(), material, initial);
  const server = createApp(engine, join(dir, 'exports'), undefined, dir);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}/api/admin/`;
  const post = (path: string, body: unknown) => fetch(base + path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try {
    const filename = '000.confirm_until_ack.json';
    await copyFile(join(experimentRoot,'config/notifications',filename),join(dir,filename));
    assert.equal((await post('config/select',{filename:'../participants.pilot.json'})).status,422);
    assert.equal((await post('config/select',{filename})).status,200);
    const created = await (await post('sessions',{participant_id:'000',config_file:filename})).json() as {session_id:string};
    assert.equal(engine.isDebug(engine.session(created.session_id)),true);
    assert.equal(engine.view(created.session_id).confirmation_enabled,true);
    const config = structuredClone(initial); config.config_name = '导入测试';
    const first = await (await post('config',{filename:'同名.json',config})).json() as {filename:string};
    const second = await (await post('config',{filename:'同名.json',config})).json() as {filename:string};
    assert.notEqual(first.filename,second.filename);
    assert.deepEqual(JSON.parse(await readFile(join(dir,first.filename),'utf8')),config);
    assert.equal(engine.session(created.session_id).snapshot.participant.stages[0].display_mode,'confirm_until_ack');
    assert.equal((await post('config',{filename:'bad.json',config:{}})).status,422);
    const state = await (await fetch(base+'config')).json() as {selected_file:string;files:unknown[]};
    assert.equal(state.selected_file,second.filename); assert.equal(state.files.length,3);
    assert.equal(engine.store.setting('selected_config_file'),second.filename);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); await engine.settle();store.close();await rm(dir,{recursive:true,force:true}); }
});
