# 公共实验启动器

仓库根目录的macOS.command、Windows.bat及 `npm run launcher` 均运行experiment-launcher.mjs。启动器负责选择实验和管理服务，不含题目、消息模式或实验状态机。

## 现场设备配置

Windows存在 `.a5-local/device.json` 时，SH的启动与重启调用scripts/rayneo-control.mjs，检查绑定设备和USB授权后使用真机模式；失败不降级Mock。状态命令显示实际模式，只有显式选择9/mock才进入模拟。其他实验或未配置设备的环境使用通用启动。

在另一台Windows主机上准备：

- 完整platform-tools放到 `.a5-local/android/platform-tools/`，优先使用其中adb.exe。
- 完整scrcpy放到 `.a5-local/scrcpy/`，可执行文件、DLL和server文件保持齐全。
- 创建device.json，最小配置为 `{"packageName":"link.ironip.a5.rayneo.localfix"}`，按实际安装包填写。单副已授权设备可自动保存serial；多设备须明确指定。
- 已有工具可填写adbPath、scrcpyPath。显示端尚未安装时先按 [Android构建说明](../f5-sh-pilot/rayneo-display/BUILDING.md) 部署，或配置apkPath与apkSha256供启动脚本校验安装。

工具和设备凭据不提交Git。修改路径或绑定后重启服务加载；换设备须先结束原会话。应用内守护、通知和硬件验收见 [RAYNEO.md](../f5-sh-pilot/RAYNEO.md)。

## 新实验接入

启动器按名称发现根目录f5-sh-*、f5-sl-*、f5-mh-*、f5-ml-*。未配置启动方式的目录也会列出并提示缺失项。在实验package.json声明：

```json
{
  "a5": {
    "launcher": {
      "entry": "src/server.ts",
      "port": 5173,
      "health_path": "/api/health",
      "admin_path": "/admin"
    }
  }
}
```

entry相对实验目录，以当前Node版本运行。实验提供自己的start/check/doctor命令；install在仓库根目录执行npm ci。

服务约定：

- 从PORT读取端口。SH默认监听0.0.0.0供局域网使用，健康检查和控制通道使用127.0.0.1；start可指定其他端口。
- 健康接口包含ok:true和对应experiment_id，通过后才报告运行中。
- A5_RUNTIME_DIR与A5_EXPORT_DIR分别指向该实验数据和导出，不与其他实验共用。
- SH直接打开/admin；其他实验如声明admin_key_file，凭据文件路径必须在实验目录内。
- 收到IPC消息 `{ "type":"a5:shutdown" }` 后停止接收、保存和关闭数据，再断开IPC；管理进程意外断开也应正常关闭。

## 生命周期与检查

每个实验由独立后台管理进程承载，退出菜单不停止服务。状态、随机控制凭据和日志位于 `.launcher/<实验>/`，不提交Git；重新打开启动器可继续管理。不会只根据持久化PID终止进程，也不会结束占用端口的无关服务。

停止使用IPC正常关闭，不以taskkill强制结束数据库。最多等待45秒，以容纳展示结束和权限恢复；超时保留诊断，不假报成功。并发启动由锁保护，异常锁30秒后可恢复。

`npm run test:launcher` 使用临时目录和独立端口，覆盖目录发现、后台/重复启动、跨菜单状态、端口冲突、遗留锁、USB启动配置、实际SH服务IPC和SQLite完整性。测试数量以命令输出为准，不写正式被试数据。Windows入口还需核对CRLF、UTF-8控制台、中文和空格路径；macOS入口可执行 `bash -n a5-experiments.command`。
