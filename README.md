# a5-experiments

A5 实验程序仓库（[5nix/a5-experiments](https://github.com/5nix/a5-experiments)）。

| 实验 | 场景 | 版本 |
| --- | --- | --- |
| [f5-sh-pilot](f5-sh-pilot/README.md) | SH 静态高负荷 | Pilot |
| [f5-sl-pilot](f5-sl-pilot/README.md) | SL 静态低负荷 | Pilot |

每套实验目录按 `f5-<sh|sl|mh|ml>-<版本>` 命名，内容、预分配、配置、测试和数据放在各自目录里；多个实验共用的代码放在 `packages/`：

| 公共包 | 内容 |
| --- | --- |
| [@a5/glasses](packages/a5-glasses) | 眼镜通信：契约、Mock 与雷鸟适配器、Android 显示端（`rayneo-display/`）。所有分项（静态桌面、以后的动态行走）都通过它给眼镜发消息。 |
| [@a5/desktop](packages/a5-desktop) | 静态桌面模拟：状态机、存储、导出、被试端与后台页。SH、SL 共用；分项差异由各自的 `config/experiment.json` 与 `content/tasks.json` 声明。 |

根目录只存放共用的启动器（`scripts/`）、npm 工作区配置和 TypeScript 公共配置。

## 启动器

安装包含 npm 的 Node.js 24+ 后，双击 `a5-experiments.command`（macOS）或 `a5-experiments.bat`（Windows 11 已实机验证），也可以运行 `npm run launcher`。首次运行先选择实验并输入 `i` 安装依赖，再输入 `1` 启动、`5` 打开后台。安装 Node.js 后请重新打开终端。先选择实验，再输入数字或指令：

`1 start [端口]` 启动 · `2 stop` 停止 · `3 restart` 重启 · `4 status` 状态 · `5 open` 打开后台 · `6 logs` 日志 · `7 check` 检查 · `8 doctor` 自检 · `i install` 安装依赖（npm ci） · `0 back` 返回 · `q quit` 退出（服务继续运行）

启动器只管理由它自己启动的服务，状态和日志保存在 `.launcher/<实验>/`。

Windows 本机已配置 `.a5-local/device.json` 时，选择 SH 或 SL 的 `1` 启动或 `3` 重启会自动使用项目内 ADB 和 USB 真机模式，设备不可用会明确报错。`4` 可核对实际模式和连接状态；`9/mock` 是显式模拟入口。

## 命令

```bash
npm ci
npm run check                                  # 所有工作区检查 + 启动器测试
npm run start --workspace=f5-sh-pilot   # 后台 http://127.0.0.1:5173/admin
npm run start --workspace=f5-sl-pilot   # 后台 http://127.0.0.1:5174/admin
```

各实验的 `runtime/`、`exports/`、凭据和依赖都已被 Git 忽略。实验数据需按各实验 README 的说明单独备份。

Windows 检出时请保留 `.gitattributes`：材料源文件 `f5-sh-pilot/docs/PRD.md` 必须使用 LF 换行，否则启动时的 SHA-256 完整性校验会失败。验收范围见 [TESTING.md](f5-sh-pilot/TESTING.md)。
