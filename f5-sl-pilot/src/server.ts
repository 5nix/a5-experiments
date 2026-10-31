// SL 分项入口：设置分项目录后启动公共桌面模拟服务（@a5/desktop）。
import { resolve } from 'node:path';
process.env.A5_EXPERIMENT_ROOT ??= resolve(import.meta.dirname, '..');
await import('@a5/desktop/server.ts');
