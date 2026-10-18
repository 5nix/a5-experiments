# 雷鸟眼镜接入

电脑端适配器和专用 Android 显示端都已实现：APK 构建、Lint 检查和签名校验通过，协议也用替身联调过。**真实眼镜尚未实测**，`pilot_ready` 和 `real_presentation_verified` 仍为 false。

## 设备与构建

- **SDK**：`MercuryAndroidSDK-v0.2.6`（SHA-256 `5d408e2c…be2676`），通过 `BaseMirrorActivity` 在双眼显示原生 View。具体型号和固件兼容性须现场核对。
- **显示端**：`rayneo-display/`，包名 `link.ironip.a5.rayneo`，不依赖 `reffers/`。支持一台服务器对应一副指定序列号的眼镜，同一设备只允许一个活跃会话。
- **构建环境**：JDK 21、Android SDK 37、AGP 9.3.1、Gradle 9.5.0（使用 Wrapper），详见 [rayneo-display/BUILDING.md](rayneo-display/BUILDING.md)。

```sh
cd f5-sh-pilot/rayneo-display
./gradlew :app:assembleDebug            # Windows: .\gradlew.bat
adb -s <序列号> install -r app/build/outputs/apk/debug/app-debug.apk
adb -s <序列号> shell am start -n link.ironip.a5.rayneo/.MainActivity
```

显示程序必须保持在前台，空闲时为纯黑画面。正式展示期间不要重装、更新或卸载；卸载或清除应用数据会丢失设备端的去重记录。

## 运行模式

默认 `mock`。真实模式需显式指定（PowerShell 用 `$env:变量='值'`）：

```sh
A5_GLASSES_MODE=rayneo A5_RAYNEO_SERIAL=<序列号> [A5_ADB_PATH=<adb路径>] \
A5_RUNTIME_DIR=/tmp/a5-rayneo-runtime A5_EXPORT_DIR=/tmp/a5-rayneo-exports \
PORT=5174 npm run start --workspace=f5-sh-pilot
```

- 显示端未就绪或正在忙时，不能创建真实会话。
- 会话创建时会固定 `device_id=adb:<序列号>`，之后改环境变量也不能把它转到别的设备或转为 Mock。
- 断线重连后不补发已经触发过的刺激。

## 协议

电脑端通过 `adb forward tcp:0 localabstract:a5-rayneo-v1` 建立持久 TCP 连接，以每行一个 JSON 通信（`protocol: a5-rayneo/1`）。眼镜端只接受 shell 或 root UID 的连接，不联网，同一时间只允许一个控制端。

| 命令 | 结果 |
| --- | --- |
| `status` | `ready`、`busy`、`ledger_id` |
| `show` | 请求包含业务 ID、`device_id`、`text`、`duration_ms: 8500`；返回 `deduplicated` 和正文的 SHA-256 |
| `events` | `{after: seq}`，每次最多返回 25 条事件 |

- **正文排版**：白字黑底，居中，字号 24→18 px 自动缩小，行距 1.5。如果仍放不下，报 `device_text_does_not_fit`，不截断正文。
- **超时**：单次 RPC 最多 3 秒，适配器整体最多 5 秒；之后每秒轮询事件，不等待 8.5 秒。

## 证据与时钟

- **事件链**：眼镜端先落盘请求并记 `accepted`，再绘制。双眼绘制完成记 `drawn`，按设备 uptime 计时 8500 ms 后清屏，清屏绘制完成记 `hidden`。电脑侧的任何操作都不影响这段计时。
- **时间字段**：事件保存设备原始的 `device_wall_ms`、`device_monotonic_ms` 和 `clock_id`。电脑与眼镜之间不做时钟换算，`t_display` / `t_hide` 为 null；`t_ack` 只表示电脑收到了接受应答。
- **证据效力**：`drawn` / `hidden` 只是应用层证据，不证明光学出光或被试实际阅读。`application_presentation_complete` 可以变为 true，但 `real_presentation_verified` 不会自动改变。
- **去重**：电脑端按“会话 + 任务组”至多发一次；眼镜端按 request_id 永久去重，同一 ID 内容不同则拒绝。
- **不排队**：眼镜忙碌或不在前台时直接拒绝新消息。
- **异常**：进程重启、Activity 销毁、绘制超时等记为失败或“待核查”，不重播。传输超时不等于未显示，也不自动补发。

## 前端与后台的眼镜相关实现

- **被试端触发**（`public/experiment.js`）：
  - **E / T0**：U1 附件被点开后，左侧查看器窗口实际显示并完成两帧绘制（`openAttachment → fillViewer → showViewer → visiblePaint(viewer)`），不再是页内展开。
  - **T1**：U1 提交后渲染 U2；先关闭查看器、把工作台置顶，再报告 `displayed`。
  - 关闭附件发 `reveal(open:false)`，重开时不重复记 E。
  - 被试页从不显示消息，不发关闭指令。
  - 宽度 <1180 px 时附件和草稿本浮在工作台上方；若要求 T0 时附件完全无遮挡，现场须使用 ≥1180 px 宽并注明。
- **情景时钟**：任务组内一直显示。部分刺激涉及时间（如 N01“调整为13:30开始”），分析消息理解时需知道这一呈现。
- **管理端**（`public/admin.js`）：
  - `deviceInfo()`：顶栏显示 Mock / 连接中断 / 未就绪 / 正在展示 / 就绪。
  - `messageStepOne/Two()`：“发送请求”和“眼镜显示”两步；`message_evidence` 为 drawn / hidden 时显示为“应用证据”，failed 时提示核查。
  - `ATTENTION`：已为 `device_*` 与 `*_delivery_unknown` 预置中文提示；服务端新增 attention 代码时须在这里补文案。
  - 另有绑定设备行，以及含来源、`t_send`、`t_ack` 的消息请求表。
  - 真实设备下的这些显示均未截图验证。
- **电脑端时间基线**（Mock 下实测）：客户端到服务端 0—4 ms，触发到排期 0 ms，`t_send` 晚 1 ms。

## 真机验收步骤

1. 用 rayneo 模式启动独立 runtime，确认顶栏显示“显示端就绪”，再新建会话（v4 快照）。
2. 运行 `qa/browser/flow.mjs`（000）与 `timestamps.mjs`（001），同时录像或用外部手段测量眼镜画面；在真实模式下截图管理端，存为 `qa/admin-device-*.png`。`admin.mjs` 中针对 Mock 文案的断言需改写。
3. 按下表逐项记录，未执行的项不能算通过：

| 项目 | 证据 |
| --- | --- |
| 设备 | 型号、固件、Android、SDK、序列号、宿主系统、APK 哈希 |
| 正文 | 四条刺激的中文、标点、换行、双眼完整显示，字级合适 |
| 计时 | 外部测量 8500 ms 及误差，同时保留 drawn / hidden 原始值 |
| 触发 | T0 / T1 / NONE 正确；同一任务组往返不重发 |
| 并行 | 切页、问卷、暂停、结束、跳过休息都不影响展示 |
| 故障 | 拔 USB、设备重启、切到后台、显示端忙碌、超时、第二个控制端：都能诊断，不出现假成功 |
| 导出 | 设备绑定、业务 ID、原始证据及 null 时间与后台一致 |

4. 验收通过后再修改：`pilot_ready` / `real_presentation_verified` 的来源（`preflight.ts`、`app.ts` health、summary、导出清单），管理端 `deviceInfo()` 与 preflight 中“尚待验收”的文案，以及各文档的“未验证”项。

仍不支持：多副眼镜、电脑与眼镜之间的时钟同步、跨电脑访问。
