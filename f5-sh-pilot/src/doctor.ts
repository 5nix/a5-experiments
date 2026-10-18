import { preflight } from './preflight.ts';

try {
  const result = await preflight();
  console.log(JSON.stringify(result, null, 2));
  console.log(result.startup_ok ? '核心软件启动检查通过；当前眼镜为Mock，真实呈现尚待接入验证。' : '启动检查失败，请处理上述错误后启动。');
  if (!result.startup_ok) process.exitCode = 1;
} catch (error) {
  console.error('初始化检查失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
