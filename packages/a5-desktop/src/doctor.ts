import { preflight } from './preflight.ts';

try {
  const result = await preflight();
  console.log(JSON.stringify(result, null, 2));
  console.log(result.startup_ok ? '核心软件启动检查通过；眼镜模式由启动配置选择，雷鸟硬件呈现仍需现场验收。' : '启动检查失败，请处理上述错误后启动。');
  if (!result.startup_ok) process.exitCode = 1;
} catch (error) {
  console.error('初始化检查失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
