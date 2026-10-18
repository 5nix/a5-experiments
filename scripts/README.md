# 公共实验启动器

根目录的macOS `.command`、Windows `.bat`和 `npm run launcher` 都运行 `experiment-launcher.mjs`。它只提供终端选择和管理，不包含任何实验题目或业务流程。

## 新实验接入

启动器按名称自动发现根目录的 `f5-sh-*`、`f5-sl-*`、`f5-mh-*`、`f5-ml-*` 目录。没有配置启动方式的目录也会列出，并提示需要配置的内容。

当前启动器管理Node服务入口。在实验自身package.json中声明：

```json
{
  "a5": {
    "launcher": {
      "entry": "src/server.ts",
      "port": 5173,
      "health_path": "/api/health",
      "admin_path": "/admin",
      "admin_key_file": "runtime/admin-key"
    }
  }
}
```

entry相对于实验目录，由当前Node进程的同版本可执行文件运行。它不需要在公共启动器中写死实验名。各实验仍需提供自己的start/check/doctor等npm命令；菜单的check/doctor调用所选实验的对应脚本，install调用仓库根目录的npm ci。

服务入口需遵守：

- 从PORT读取端口，绑定本机127.0.0.1。启动器支持 `start 其他端口`，不同实验可同时使用不同端口。
- 健康接口返回 `{ "ok": true, "experiment_id": "与实验目录名相同" }`；健康检查通过后才显示“运行中”。
- 使用A5_RUNTIME_DIR、A5_EXPORT_DIR保存运行数据与导出。管理器将其分别设为所选实验的runtime和exports，不与其他实验混用。
- 如配置admin_key_file，打开后台时读取该文件并以 `#key=...` 附到URL；未配置则只打开后台地址。文件路径必须在实验目录内。
- 监听Node进程IPC消息 `{ "type": "a5:shutdown" }`，收到后停止接受请求、保存并关闭数据，最后调用 `process.disconnect?.()`。管理进程意外断开时也应正常关闭。SH实验入口已实现此约定。
- 8.5秒眼镜计时等实验规则仍由实验自身负责，公共启动器不介入。

## 进程管理

每套实验有独立后台管理进程，启动器菜单退出后不会带走实验服务。管理进程保存状态并提供带随机凭据的本机控制通道；重新打开菜单即可继续管理。不会只根据持久化PID杀进程，避免PID复用时误停无关程序。

状态、管理凭据和追加日志位于 `.launcher/<实验目录>/`，不进入Git。停止时通过IPC请求正常关闭，等待进程退出，不调用Windows taskkill强制终止数据库。停止超时会保留提示，不假报成功。管理进程若异常退出，实验服务通过IPC断开事件自行关闭。

短时间同时启动由锁保护，异常终止遗留的启动锁在30秒后可恢复。端口占用、入口错误或健康检查失败都会显示错误，详情写入service.log；不会杀掉占用端口的其他服务。

## 检查

`npm run test:launcher`包含7项公共测试：动态发现、重复/后台启动和跨菜单状态、正常关闭、错误凭据、端口冲突及启动失败、非管理服务保护、遗留锁恢复、实际SH服务IPC及SQLite完整性、入口格式与菜单（部分检查合并在同一测试项）。测试使用临时目录和独立端口，不写入真实被试数据。

macOS入口可用 `bash -n a5-experiments.command` 检查；Windows文件使用CRLF、UTF-8控制台及带引号路径。Windows 11 已验证批处理菜单、启动、重启、跨菜单状态、正常停止和浏览器打开；7项启动器测试全部通过，包含中文及空格临时路径和SQLite完整性。测试清理对Windows进程退出时短暂的目录锁执行有限重试。
