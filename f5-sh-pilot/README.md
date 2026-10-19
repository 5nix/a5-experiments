# f5-sh-pilot

SH（静态高负荷）场景的 Pilot 实验程序，属于 [a5-experiments](../README.md)。

**当前状态**：5 组 10 单元、问卷、可跳过的休息、会话恢复、导出、Windows 11 风格的被试桌面、管理端 v2 都已完成；内容版本为 v4。Windows 和真实雷鸟修复版 1.0.1 已完成软件及应用绘制流程验收；后台支持上位机守护、独立测试通知、USB 重连和 scrcpy 裁剪调试。外部光学显示/计时仍待现场验收。

## 启动

需要 Node.js 24+。双击仓库根目录的 `a5-experiments.command` 或 `a5-experiments.bat`，选择本实验后输入 `start` / `open` / `restart` / `stop`；也可以用命令：

```bash
npm ci && npm run check            # 仓库根目录
npm run start --workspace=f5-sh-pilot
```

启动后打开终端里打印的 `http://127.0.0.1:5173/admin#key=…`，在后台创建会话，再把被试入口打开在被试电脑上。端口冲突时在启动器输入 `start 5174`；直接使用 PowerShell 时先执行 `$env:PORT = '5174'`，再执行启动命令。连续预演请用 `start`，不要用 `dev`。

- **编号**：001—004 为 V1 预分配；000 是调试测试者，复制 001 的配置，可以跳题。
- **会话限制**：同一编号同时只能有一个未结束的会话；不同编号可以并行。
- **修改内容后**：修改 `content/` 后必须重启服务并新建会话，已有会话始终显示创建时的内容快照。

## 数据

- **存放位置**：`runtime/experiment.sqlite`（WAL 模式）、`runtime/admin-key`、`exports/<编号>/`，都已被 Git 忽略。
- **备份**：先停止服务，再复制整个 `runtime/` 和需要保留的 `exports/`。
- **测试隔离**：测试时用 `A5_RUNTIME_DIR` / `A5_EXPORT_DIR` 指定独立目录。
- **导出范围**：“导出全部”包含所有未删除会话（含 000 和未完成的会话），“导出当前”只导出选中的那一次会话。删除会话可恢复。

## 内容维护

运行时读取 `content/tasks.json` 与 `content/stimuli.json`。`tasks.json` 由脚本从原始附件和 `content/revisions.json` 生成：

```bash
python3 scripts/build_task_content.py   # 只用 Python 标准库
```

修改文案时先编辑 `revisions.json`，再生成并提升 `content_version`。字段 ID 保持不变，评分写在各单元的 `scoring` 中。

## 文档

| 文档 | 内容 |
| --- | --- |
| [DECISIONS.md](DECISIONS.md) | 当前执行规则与材料处理（优先于 PRD） |
| [API.md](API.md) | 接口、view、操作、时序 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 组成、状态、时间与持久化 |
| [FRONTEND.md](FRONTEND.md) | 被试桌面与管理端 |
| [RAYNEO.md](RAYNEO.md) | 眼镜接入与真机验收清单 |
| [TESTING.md](TESTING.md) | 测试与验收结果 |
| [qa/browser/](qa/browser/README.md) | 可重跑的浏览器验收脚本 |
| [docs/](docs/) | 原始 PRD、Word、XLSX |
