import { lanAddresses } from './network.mjs';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, connect } from 'node:net';
import { open, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const repositoryRoot = resolve(import.meta.dirname, '..');
const managerFile = fileURLToPath(import.meta.url);
const experimentPattern = /^f5-(sh|sl|mh|ml)-[a-z0-9][a-z0-9-]*$/;
const paths = (root, name) => ({ directory: join(root, '.launcher', name), state: join(root, '.launcher', name, 'state.json'), log: join(root, '.launcher', name, 'service.log'), lock: join(root, '.launcher', name, 'start.lock') });
const readState = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
async function saveState(path, state) { const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, path); }

export async function discoverExperiments(root = repositoryRoot) {
  const result = [];
  for (const directory of await readdir(root, { withFileTypes: true })) {
    if (!directory.isDirectory() || !experimentPattern.test(directory.name)) continue;
    const path = join(root, directory.name);
    let pkg;
    try { pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')); }
    catch (error) { result.push({ name: directory.name, path, title: directory.name, launcher: null, problem: error.code === 'ENOENT' ? '尚未配置 package.json' : 'package.json无法读取' }); continue; }
    const launcher = pkg.a5?.launcher;
    let problem = null;
    if (!launcher || typeof launcher.entry !== 'string') problem = '尚未配置 a5.launcher.entry';
    else {
      const entry = relative(path, resolve(path, launcher.entry));
      if (!entry || entry.startsWith(`..${sep}`) || entry === '..') problem = '启动入口必须位于实验目录内';
      if (!Number.isInteger(launcher.port) || launcher.port < 1 || launcher.port > 65535) problem = '启动端口必须是1—65535的整数';
      for (const field of ['health_path', 'admin_path']) if (launcher[field] !== undefined && (typeof launcher[field] !== 'string' || !launcher[field].startsWith('/') || launcher[field].startsWith('//'))) problem = `${field}必须是本地绝对路径`;
      if (launcher.admin_key_file !== undefined) {
        const keyPath = typeof launcher.admin_key_file === 'string' ? relative(path, resolve(path, launcher.admin_key_file)) : '..';
        if (keyPath === '..' || keyPath.startsWith(`..${sep}`)) problem = '后台凭据文件必须位于实验目录内';
      }
    }
    result.push({ name: directory.name, path, title: pkg.description || directory.name, scripts: pkg.scripts ?? {}, launcher: problem ? null : launcher, problem });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}
async function experiment(root, name) { const found = (await discoverExperiments(root)).find(item => item.name === name); if (!found) throw new Error(`实验不存在：${name}`); return found; }
async function rpc(state, action, timeout = 2000) {
  return new Promise((resolveReply, reject) => {
    const socket = connect({ host: '127.0.0.1', port: state.control_port }); let data = '';
    socket.setTimeout(timeout, () => socket.destroy(new Error('管理进程响应超时')));
    socket.once('connect', () => socket.write(JSON.stringify({ token: state.token, action }) + '\n'));
    socket.on('data', chunk => {
      data += chunk.toString('utf8');
      if (data.length > 65536) socket.destroy(new Error('管理进程响应过长'));
      if (!data.includes('\n')) return;
      try { const result = JSON.parse(data.split('\n')[0]); socket.destroy(); if (result.worker_id !== state.worker_id) throw new Error('管理进程标识不匹配'); if (result.error) throw new Error(result.error); resolveReply(result); }
      catch (error) { reject(error); }
    });
    socket.once('error', reject);
    socket.once('end', () => { if (!data.includes('\n')) reject(new Error('管理进程已断开')); });
  });
}
async function health(item, port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${item.launcher.health_path ?? '/api/health'}`, { signal: AbortSignal.timeout(700) });
    if (!response.ok) return false;
    const value = await response.json(); return value.ok === true && value.experiment_id === item.name;
  } catch { return false; }
}
export async function getStatus(name, root = repositoryRoot) {
  const item = await experiment(root, name); const state = await readState(paths(root, name).state);
  if (state && !['stopped', 'failed'].includes(state.status)) {
    try { return await rpc(state, 'status', 1200); }
    catch { if (item.launcher && await health(item, state.port)) return { status: 'unmanaged', port: state.port, base_url: `http://127.0.0.1:${state.port}`, message: '服务可访问，但管理进程不可用；不会按旧PID停止其他进程。' }; }
  }
  if (item.launcher && await health(item, item.launcher.port)) return { status: 'unmanaged', port: item.launcher.port, base_url: `http://127.0.0.1:${item.launcher.port}`, message: '服务由其他终端启动，请在原终端停止后再由启动器管理。' };
  return { status: state?.status === 'failed' ? 'failed' : 'stopped', port: state?.port ?? item.launcher?.port ?? null, message: state?.error ?? null, log_file: paths(root, name).log };
}
export async function startExperiment(name, port, root = repositoryRoot) {
  const item = await experiment(root, name);
  if (!item.launcher) throw new Error(item.problem);
  const chosenPort = port ?? item.launcher.port;
  if (!Number.isInteger(chosenPort) || chosenPort < 1 || chosenPort > 65535) throw new Error('端口必须是1—65535的整数。');
  const existing = await getStatus(name, root);
  if (['running', 'starting', 'stopping'].includes(existing.status)) return existing;
  const location = paths(root, name); await mkdir(location.directory, { recursive: true, mode: 0o700 });
  try { await mkdir(location.lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (Date.now() - (await stat(location.lock)).mtimeMs < 30000) throw new Error('该实验正在启动，请稍后查看状态。');
    await rm(location.lock, { recursive: true, force: true });
    try { await mkdir(location.lock); } catch { throw new Error('另一个启动器正在处理该实验，请稍后查看状态。'); }
  }
  try {
    const current = await getStatus(name, root);
    if (['running', 'starting', 'stopping'].includes(current.status)) return current;
    if (current.status === 'unmanaged' && current.port === chosenPort) throw new Error(current.message);
    for (const host of ['127.0.0.1', '0.0.0.0']) await new Promise((resolveFree, reject) => {
      const probe = createServer(); probe.once('error', error => reject(new Error(error.code === 'EADDRINUSE' ? `端口${chosenPort}已被占用，可输入“start 5174”等指定其他端口。` : error.message)));
      probe.listen(chosenPort, host, () => probe.close(resolveFree));
    });
    const log = await open(location.log, 'a', 0o600);
    let child, spawned;
    try {
      child = spawn(process.execPath, [managerFile, '--worker', name, '--root', root, '--port', String(chosenPort)], { cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd], windowsHide: true });
      spawned = new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
    }
    finally { await log.close(); }
    await spawned; child.unref();
    const deadline = Date.now() + 16000;
    while (Date.now() < deadline) {
      const state = await readState(location.state);
      if (state?.manager_pid === child.pid) {
        if (state.status === 'failed') throw new Error(`启动失败：${state.error}。日志：${location.log}`);
        try { const result = await rpc(state, 'status'); if (result.status === 'running') return result; if (result.status === 'failed') throw new Error(result.message ?? '服务启动失败'); }
        catch (error) { if (state.status === 'failed') throw error; }
      }
      await delay(100);
    }
    throw new Error(`启动未在规定时间内完成，请查看状态和日志：${location.log}`);
  } finally { await rm(location.lock, { recursive: true, force: true }); }
}
export async function stopExperiment(name, root = repositoryRoot) {
  const state = await readState(paths(root, name).state); const current = await getStatus(name, root);
  if (current.status === 'unmanaged') throw new Error(current.message);
  if (['stopped', 'failed'].includes(current.status)) return current;
  if (!state) return { status: 'stopped' };
  return rpc(state, 'stop', 47000);
}
export async function readLogs(name, root = repositoryRoot) {
  const path = paths(root, name).log;
  try {
    const file = await open(path, 'r');
    try { const stat = await file.stat(); const buffer = Buffer.alloc(Math.min(stat.size, 65536)); await file.read(buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length)); return buffer.toString('utf8').split(/\r?\n/).slice(-45).join('\n'); }
    finally { await file.close(); }
  } catch (error) { if (error.code === 'ENOENT') return '尚无启动器日志。'; throw error; }
}
export async function adminUrl(name, root = repositoryRoot) {
  const item = await experiment(root, name), status = await getStatus(name, root);
  if (!['running', 'unmanaged'].includes(status.status)) throw new Error('请先启动实验。');
  const url = new URL(item.launcher.admin_path ?? '/admin', `http://127.0.0.1:${status.port}`);
  if (item.launcher.admin_key_file) { const key = (await readFile(resolve(item.path, item.launcher.admin_key_file), 'utf8')).trim(); url.hash = new URLSearchParams({ key }).toString(); }
  return url.href;
}

async function runWorker(name, root, port) {
  const item = await experiment(root, name), location = paths(root, name);
  if (!item.launcher) throw new Error(item.problem);
  const state = { worker_id: randomBytes(16).toString('hex'), token: randomBytes(32).toString('hex'), manager_pid: process.pid, server_pid: null, control_port: null, name, port, started_at: new Date().toISOString(), status: 'starting', error: null };
  let service, exitPromise, shutdownPromise;
  const publicStatus = () => ({ worker_id: state.worker_id, status: state.status, name, port, manager_pid: state.manager_pid, server_pid: state.server_pid, started_at: state.started_at, base_url: `http://127.0.0.1:${port}`, lan_urls: (process.env.HOST && process.env.HOST !== '0.0.0.0' ? [] : lanAddresses(port)).map(item => `${item.base_url}/admin`), log_file: location.log, message: state.error });
  let writes = Promise.resolve();
  const persist = () => { const snapshot = { ...state }; writes = writes.then(() => saveState(location.state, snapshot)); return writes; };
  const shutdown = () => shutdownPromise ??= (async () => {
    state.status = 'stopping'; await persist();
    if (service && service.exitCode === null && service.signalCode === null) {
      if (service.connected) service.send({ type: 'a5:shutdown' });
      else if (process.platform !== 'win32') service.kill('SIGTERM');
      else throw new Error('服务缺少正常停止通道，请检查实验入口的IPC支持。');
      let timeout;
      try { await Promise.race([exitPromise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('服务尚未正常退出，请查看日志；启动器不会强制结束数据进程。')), 45000); })]); }
      finally { clearTimeout(timeout); }
    }
    state.status = 'stopped'; state.stopped_at = new Date().toISOString(); await persist(); return publicStatus();
  })().catch(error => { shutdownPromise = undefined; throw error; });
  const control = createServer(socket => {
    let data = '', handled = false; socket.setTimeout(5000, () => socket.destroy());
    socket.on('data', async chunk => {
      data += chunk.toString('utf8'); if (data.length > 16000) { socket.destroy(); return; }
      if (handled || !data.includes('\n')) return; handled = true;
      try {
        const request = JSON.parse(data.split('\n')[0]); const supplied = Buffer.from(typeof request.token === 'string' ? request.token : ''); const expected = Buffer.from(state.token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('管理凭据无效。');
        if (!['status', 'stop'].includes(request.action)) throw new Error('未知管理指令。');
        if (request.action === 'stop') socket.setTimeout(49000, () => socket.destroy());
        const result = request.action === 'stop' ? await shutdown() : publicStatus(); socket.end(JSON.stringify(result) + '\n');
        if (request.action === 'stop') control.close();
      } catch (error) { socket.end(JSON.stringify({ worker_id: state.worker_id, error: error.message }) + '\n'); }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolveListen, reject) => { control.once('error', reject); control.listen(0, '127.0.0.1', resolveListen); });
  state.control_port = control.address().port;
  console.log(`\n[${state.started_at}] 启动 ${name}，端口 ${port}`);
  service = spawn(process.execPath, [resolve(item.path, item.launcher.entry)], { cwd: item.path, env: { ...process.env, PORT: String(port), A5_RUNTIME_DIR: join(item.path, 'runtime'), A5_EXPORT_DIR: join(item.path, 'exports') }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
  state.server_pid = service.pid ?? null;
  exitPromise = new Promise(resolveExit => {
    service.once('exit', (code, signal) => resolveExit({ code, signal }));
    service.once('error', error => resolveExit({ code: null, error }));
  });
  void exitPromise.then(async result => {
    if (state.status !== 'stopping') { state.status = 'failed'; state.error = result.error?.message ?? `服务退出（退出码${result.code ?? '无'}，信号${result.signal ?? '无'}）`; await persist(); control.close(); }
  });
  await persist();
  const deadline = Date.now() + 13000;
  while (state.status === 'starting' && Date.now() < deadline) {
    if (await health(item, port)) { state.status = 'running'; await persist(); break; }
    await delay(100);
  }
  if (state.status === 'starting') {
    const message = '健康检查未通过';
    try { await shutdown(); } catch (error) { console.error(error.message); }
    state.status = 'failed'; state.error = message; await persist(); control.close();
  }
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void shutdown().then(() => control.close()).catch(error => console.error(error.message)); });
}

if (process.argv[2] === '--worker') {
  const args = process.argv.slice(3), name = args[0], rootIndex = args.indexOf('--root'), portIndex = args.indexOf('--port');
  const root = rootIndex >= 0 ? resolve(args[rootIndex + 1]) : repositoryRoot;
  if (!experimentPattern.test(name ?? '')) throw new Error('实验名称无效。');
  await runWorker(name, root, Number(args[portIndex + 1]));
}
