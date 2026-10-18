import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Store } from './store.ts';
import { Engine } from './engine.ts';
import { createApp } from './app.ts';
import { loadMaterial } from './tasks.ts';
import { MockGlassesAdapter } from './adapters/mock-glasses.ts';
import { experimentRoot, preflight, readJson } from './preflight.ts';
import type { ParticipantConfig } from './contracts.ts';

const port = Number(process.env.PORT ?? 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT必须是1至65535之间的整数。');
const checked = await preflight();
if (!checked.startup_ok) throw new Error(`启动检查失败：${[...checked.pilot_errors, ...checked.material_errors].join('；')}`);
const runtime = resolve(process.env.A5_RUNTIME_DIR ?? join(experimentRoot, 'runtime'));
await mkdir(runtime, { recursive: true });
const keyPath = join(runtime, 'admin-key');
let adminKey: string;
try { adminKey = (await readFile(keyPath, 'utf8')).trim(); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  adminKey = randomBytes(32).toString('hex'); await writeFile(keyPath, adminKey, { mode: 0o600, flag: 'wx' });
}
const store = new Store(join(runtime, 'experiment.sqlite'));
const engine = new Engine(store, new MockGlassesAdapter(), await loadMaterial(), await readJson<ParticipantConfig>('config/participants.pilot.json'));
const server = createApp(engine, adminKey, resolve(process.env.A5_EXPORT_DIR ?? join(experimentRoot, 'exports')));
const ticker = setInterval(() => { for (const id of store.ids()) engine.tick(id); }, 1000); ticker.unref();
server.on('error', error => { console.error('服务启动失败：', error.message); clearInterval(ticker); store.close(); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`实验员后台：http://127.0.0.1:${port}/admin#key=${adminKey}`);
  console.log(`数据库：${join(runtime, 'experiment.sqlite')}`);
  console.log('当前为Mock眼镜模式，不能用于声称真实消息呈现成功。被试入口由后台创建或恢复会话后提供。');
});
let stopping = false;
const shutdown = () => {
  if (stopping) return; stopping = true; clearInterval(ticker);
  server.close(() => { void engine.settle().finally(() => { store.close(); if (process.connected) process.disconnect?.(); }); });
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
process.on('message', message => {
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'a5:shutdown') shutdown();
});
// 管理进程意外退出时正常落盘并关闭，避免遗留无主服务。
if (process.connected) process.on('disconnect', shutdown);
