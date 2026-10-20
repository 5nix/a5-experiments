import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { repositoryRoot } from './experiment-manager.mjs';

// 本机配置存在时，公共菜单必须走设备启动链路，不能绕过它默认为 Mock。
export async function localDeviceControl(item, { root = repositoryRoot, platform = process.platform } = {}) {
  if (platform !== 'win32' || item.name !== 'f5-sh-pilot') return null;
  try { await access(join(root, '.a5-local', 'device.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const entry = join(root, 'scripts', 'rayneo-control.mjs');
  try { await access(entry); } catch { throw new Error('已有眼镜配置，但缺少 scripts/rayneo-control.mjs；未启动 Mock，请恢复真机启动脚本。'); }
  return entry;
}

export async function runDeviceControl(entry, action, port) {
  const args = [entry, action, '--no-open'];
  if (port !== undefined) args.push('--port', String(port));
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('设备启动操作未完成，请查看上方诊断；不会回退为 Mock。')));
  });
}
