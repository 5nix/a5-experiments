# 浏览器验收脚本

被试端改版、管理端 v2 和时间戳验收时用过的 Playwright 脚本都放在这里，接眼镜后可以直接重跑。这些脚本不属于 `npm run check`，也不写入正式数据。

## 准备

Playwright 不是仓库依赖，需要单独安装在临时目录，以免改动 lockfile：

```sh
mkdir -p /tmp/a5pw && cd /tmp/a5pw && npm i playwright
export A5_PLAYWRIGHT=/tmp/a5pw/node_modules/playwright/index.mjs
```

浏览器使用本机安装的 Google Chrome（`channel: 'chrome'`）。

这些历史验收脚本使用 001—004 等原表编号作为固定夹具。运行前请在独立测试 runtime 的后台导入 `config/participants.source.json`；正式默认配置现为 P01—P20。`admin-import.mjs` 会将配置切回默认文件，之后运行其他历史脚本前需重新导入该测试夹具。

在独立端口和临时 runtime 启动服务，从仓库根目录执行：

```sh
PORT=5174 A5_RUNTIME_DIR=/tmp/a5-frontend-runtime A5_EXPORT_DIR=/tmp/a5-frontend-exports \
  npm run start --workspace=f5-sh-pilot
```

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `A5_BASE` | `http://127.0.0.1:5174` | 服务地址 |
| `A5_RUNTIME_DIR` | `/tmp/a5-frontend-runtime` | 预演运行目录（后台不再读取管理员 key） |
| `A5_QA_OUT` | `/tmp/a5-qa` | 截图和临时文件输出目录 |
| `A5_PLAYWRIGHT` | `playwright` | Playwright 模块路径 |

同一编号只能有一个未结束会话。每个脚本运行前先执行 `node f5-sh-pilot/qa/browser/stop-active.mjs`，它会结束测试 runtime 中所有进行中的会话。

## 脚本

| 脚本 | 内容 | 默认编号 |
| --- | --- | --- |
| `flow.mjs` | 从导入到完成的完整流程：10 个单元、问卷、跳过休息，并截图；输出关键事件计数 | `PID`，默认 000 |
| `participant-checks.mjs` | 草稿本刷新恢复、未打开附件的拒绝提示、互斥选项、快速输入后提交、金额 422、暂停/恢复保留答案、多分辨率 | `PID`，默认 001 |
| `attachment.mjs` | 附件窗口打开/关闭/重开、E 不重复、刷新后恢复、工作台关闭按钮置灰 | 001 |
| `timestamps.mjs` | 时间戳验收（23 项）：事件格式与单调、客户端证据、已知时长、T0/T1 排期、暂停、休息、后台显示、导出 | 001 |
| `scene-clock.mjs`、`scene-clock-flash.mjs` | 右下角情景时钟：取值、切换任务组、闪烁、刷新不重复闪烁 | 000 |
| `admin.mjs`、`admin-import.mjs` | 管理端 v2：46 项操作检查与截图；配置导入（合法、非法各一次） | 000、001 |
| `stop-active.mjs` | 结束测试 runtime 中所有进行中的会话 | — |

## 接眼镜后怎么用

真实模式下，显示端未就绪时不能创建会话，测试前先确认管理端顶栏显示“显示端就绪”。

- **只看眼镜与时序**：重点跑 `timestamps.mjs` 和 `flow.mjs`。
- **核对管理端**：另跑 `admin.mjs`；其中“模拟（Mock）”相关断言在真实模式下预期不成立，需要按真实设备的状态文字改写。

真机验收步骤见 [RAYNEO.md](../../RAYNEO.md)。
