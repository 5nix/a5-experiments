// 必须是每个测试文件的第一个导入：固定分项目录，使公共包读取本分项的 config/ 与 content/，与启动目录无关。
import { resolve } from 'node:path';
process.env.A5_EXPERIMENT_ROOT = resolve(import.meta.dirname, '..');
