# a5-experiments

A5 实验程序仓库，用于管理不同场景及实验版本。所有实验共用一个 Git 仓库：[5nix/a5-experiments](https://github.com/5nix/a5-experiments)。本地文件夹名称保持为 `A5实验程序`。

## 实验索引

| 实验目录 | 场景 | 版本 | 说明 |
| --- | --- | --- | --- |
| [f5-sh-pilot](f5-sh-pilot/README.md) | SH 静态高负荷 | Pilot | 启动、流程、材料、数据与验收见该实验的 README |

新增实验时在此登记，其具体需求、实现状态和使用说明放在各自目录内。

## 命名与目录

每套实验使用 `f5-场景-分支` 命名：`f5` 固定，场景为 `sh`、`sl`、`mh`、`ml` 之一，最后一段为 `pilot` 等实验版本标识。该标识属于实验目录名，不要求建立同名 Git 分支或嵌套 Git 仓库。

```text
a5-experiments/
  AGENTS.md             全局协作要求
  README.md             仓库说明与实验索引
  a5-experiments.command macOS 双击入口
  a5-experiments.bat     Windows 双击入口
  scripts/              各实验共用的终端启动器与进程管理
  package.json          npm 工作区与汇总检查命令
  package-lock.json     npm 依赖锁定
  tsconfig.base.json    TypeScript 公共编译选项
  f5-sh-pilot/           SH Pilot 实验，独立 README、代码、配置和工具
  f5-其他场景-版本/       后续实验目录，按实际需要新增
```

每套实验的 `src/`、前端、`config/`、`content/`、`docs/`、`scripts/`、测试、运行数据和导出都归入其自身目录。根目录只保留确实共用的配置与工具；当前没有需要抽出的共享业务模块。

## 交互启动器

安装 Node.js 24+ 后，在 macOS 双击根目录的 `a5-experiments.command`，在 Windows 双击 `a5-experiments.bat`。也可在仓库根目录运行 `npm run launcher`。

启动器自动列出符合命名规范的实验目录，先输入数字选择实验，再输入数字、英文指令或中文指令：

| 数字或指令 | 操作 |
| --- | --- |
| `1` / `start` / `启动` | 后台启动所选实验；支持 `start 5174` 指定端口 |
| `2` / `stop` / `停止` | 正常停止实验服务并关闭数据库 |
| `3` / `restart` / `重启` | 停止后重新启动，默认沿用当前端口 |
| `4` / `status` / `状态` | 查看运行状态与地址 |
| `5` / `open` / `打开` | 在浏览器打开带凭据的实验员后台 |
| `6` / `logs` / `日志` | 查看最近的服务日志 |
| `7` / `check` / `检查` | 执行所选实验的完整检查 |
| `8` / `doctor` / `自检` | 执行所选实验的启动自检 |
| `i` / `install` / `安装依赖` | 在仓库根目录运行 `npm ci`，首次使用可先执行 |
| `0` / `back` / `返回` | 返回实验列表，选择其他实验 |
| `q` / `quit` / `退出` | 退出启动器，已启动服务继续运行 |
| `help` / `帮助` | 重新显示指令菜单 |

需要停止服务时先输入 `stop`；重新打开启动器仍可查看、停止此前启动的服务。管理状态与日志分别保存在 `.launcher/<实验目录>/`，由Git忽略。启动器只管理自己启动的服务，不按端口或旧PID强杀进程；对于其他终端启动的服务，会提示在原终端停止后再使用启动器。

macOS入口已设置执行权限；Windows入口使用UTF-8控制台和CRLF换行。两者共用同一套Node管理逻辑。Windows双击行为尚待实机验证。

## 工作区命令

当前 npm 工作区使用 Node.js 24+，从仓库根目录统一安装依赖：

```bash
npm ci
```

运行某套实验时必须显式选择工作区，例如：

```bash
npm run start --workspace=f5-sh-pilot
npm run dev --workspace=f5-sh-pilot
npm run check --workspace=f5-sh-pilot
```

也可以进入对应实验目录，再使用该实验 README 中的命令。根目录不默认启动任何实验。

根目录的 `npm run check`、`npm test`、`npm run typecheck`、`npm run doctor` 汇总执行已注册工作区支持的对应命令；其中check/test还包含公共启动器测试，可用 `npm run test:launcher` 单独执行。新增 npm 实验包使用上述目录命名，并在自身 `package.json` 中声明需要的命令。注册交互启动方式见 [公共启动器说明](scripts/README.md)。

## 数据与版本管理

原始材料、代码和可公开的示例随对应实验保存。各实验的 `runtime/`、`exports/`、本机凭据、依赖和临时文件由根 `.gitignore` 统一排除。

实际实验数据需要单独备份，具体位置和操作按各实验 README 执行。不要将某套实验的被试配置、数据或内容版本当作仓库全局配置。
