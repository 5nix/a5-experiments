import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(new URL('../../../package.json', import.meta.url));
const { unzipSync } = require('fflate');
const apk = process.argv[2];
if (!apk) throw new Error('请提供 APK 路径。');
const files = unzipSync(new Uint8Array(await readFile(resolve(apk))));
const dex = Object.entries(files).filter(([name]) => /^classes\d*\.dex$/.test(name)).map(([, data]) => Buffer.from(data));
/** 读取 DEX 类定义表，避免把仅出现在字符串池中的类误判为已打包。 */
function definedClasses(data) {
  if (data.toString('ascii', 0, 4) !== 'dex\n') throw new Error('未知 DEX 格式');
  const strings = data.readUInt32LE(60);
  const types = data.readUInt32LE(68);
  const count = data.readUInt32LE(96);
  const classes = data.readUInt32LE(100);
  const result = new Set();
  for (let i = 0; i < count; i++) {
    const typeIndex = data.readUInt32LE(classes + i * 32);
    const stringIndex = data.readUInt32LE(types + typeIndex * 4);
    let offset = data.readUInt32LE(strings + stringIndex * 4);
    while (data[offset++] & 128) { /* 跳过 ULEB128 的 UTF-16 长度。 */ }
    const end = data.indexOf(0, offset);
    result.add(data.toString('utf8', offset, end));
  }
  return result;
}
const definitions = new Set(dex.flatMap(data => [...definedClasses(data)]));
const required = ['Landroidx/lifecycle/ViewModelKt;', 'Landroidx/lifecycle/LifecycleOwnerKt;', 'Lcom/ffalcon/mercury/android/sdk/touch/TempleActionViewModel;'];
const checks = required.map(descriptor => ({ descriptor, packaged: definitions.has(descriptor) }));
console.log(JSON.stringify({ dex_files: dex.length, checks, passed: checks.every(check => check.packaged) }, null, 2));
if (checks.some(check => !check.packaged)) process.exitCode = 1;
