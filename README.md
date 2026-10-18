# a5-experiments

A5 实验程序仓库（[5nix/a5-experiments](https://github.com/5nix/a5-experiments)）。

| 实验 | 场景 | 版本 |
| --- | --- | --- |
| [f5-sh-pilot](f5-sh-pilot/README.md) | SH 静态高负荷 | Pilot |

每套实验目录按 `f5-<sh|sl|mh|ml>-<版本>` 命名，代码、内容、配置、测试和数据都放在各自目录里。根目录只存放共用的启动器（`scripts/`）、npm 工作区配置和 TypeScript 公共配置。

## 启动器

安装 Node.js 24+ 后，双击 `a5-experiments.command`（macOS）或 `a5-experiments.bat`（Windows，未实机验证），也可以运行 `npm run launcher`。先选择实验，再输入数字或指令：

`1 start [端口]` 启动 · `2 stop` 停止 · `3 restart` 重启 · `4 status` 状态 · `5 open` 打开后台 · `6 logs` 日志 · `7 check` 检查 · `8 doctor` 自检 · `i install` 安装依赖（npm ci） · `0 back` 返回 · `q quit` 退出（服务继续运行）

启动器只管理由它自己启动的服务，状态和日志保存在 `.launcher/<实验>/`。

## 命令

```bash
npm ci
npm run check                                  # 所有工作区检查 + 启动器测试
npm run start --workspace=f5-sh-pilot
```

各实验的 `runtime/`、`exports/`、凭据和依赖都已被 Git 忽略。实验数据需按各实验 README 的说明单独备份。
