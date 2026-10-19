# 架构

## 组成

| 位置 | 职责 |
| --- | --- |
| src/server.ts | 启动、局域网监听、路径、正常停止 |
| src/app.ts | HTTP 接口、实验员与被试隔离、固定静态白名单、CSP（只允许本站脚本和样式） |
| src/engine.ts | 会话状态机、操作去重、时钟、E/F、问卷与休息、消息调度 |
| src/store.ts | SQLite 事务、快照、只追加事件、消息记录 |
| src/tasks.ts | 内容载入、输入归一化、评分（含排班约束） |
| src/export.ts | CSV / JSONL / 快照 / 清单 / ZIP |
| src/adapters/ | Mock 与雷鸟眼镜适配器 |
| src/device-control.ts | 上位机守护、唤醒/拉回、USB 重连、独立调试通知与 scrcpy 子进程 |
| content/ | tasks.json、stimuli.json、revisions.json、来源与归档 |
| scripts/ | 从原始附件重建内容（Python 标准库） |
| public/ | 被试端（experiment.* + desktop.css）与管理端（admin.* + app.css），样式互相隔离 |
| rayneo-display/ | 眼镜端 Android 显示程序 |

依赖：Node.js 24+、fflate；使用 Node 内置 SQLite，不引入需要编译的原生模块。已在 macOS 上验证，Windows 未实机验证。

## 状态与提交

- **服务端权威**：服务端掌握权威状态和校验。每个页面有一个不可猜测的 page_token，旧页面无法再提交。
- **操作去重**：command_id 在数据库中唯一，重试同一操作不会重复写入或重复推进。
- **评分**：评分和正确选项只保存在服务端。

## 时间与持久化

- **写入**：SQLite 开启 WAL 与 `synchronous=FULL`，状态、事件和发送意图在同一事务中写入。事件表用触发器禁止更新和删除。
- **计时**：`elapsed_ms` 由服务端单调时钟计算，暂停期间照常计时（休息结束时间会顺延）。服务重启后，取“持久化的已用时长”和“从开始到现在的墙钟时长”中较大的值续上，并记录 `server_restarted`。
- **客户端证据**：浏览器绘制时间作为客户端证据保存在事件 payload 中，与服务端接收时间分开。
- **未决消息**：重启时尚无最终回执的消息标为 unknown，不会重放。

## 消息

- **发送顺序**：触发后先在事务中保存请求和 request_id，再非阻塞调用适配器；设备的接受、绘制、清屏、失败等证据按 request_id 合并。
- **去重与关联**：每个会话的每个任务组至多一条消息；迟到的回调仍归入原任务组。
- **雷鸟链路**：雷鸟眼镜经 ADB 建立 USB 隧道后，通过持久 TCP 通信，详见 [RAYNEO.md](RAYNEO.md)。

## 上位机与独立调试数据

`DeviceControl` 复用引擎的唯一眼镜适配器，ADB 命令只管理唤醒、前台和隧道生命周期。设备消息通过原套接字发送，原始 drawn/hidden 时钟不换算。正常显示期间不执行前台恢复，断线后等待发送保护期结束再恢复，不能因上位机守护而重发刺激。

独立测试通知在 `device_debug_requests` 保存 request_id、正文、设备绑定、回执与事件。引擎先将匹配的调试事件路由至该表，其他事件继续原实验关联规则。通知记录和实验 interventions 分开；测试通知、设备控制和新建实验之间有忙碌互斥。守护开关保存在 settings，操作留在 admin_audit；服务关闭时先等待当前控制结束，再关闭适配器和数据库，并回收自己启动的 scrcpy 进程。

## 删除

删除只在 `state.deleted` 中做标记，不改动事件和快照。默认列表、启动扫描和全部导出都排除已删除会话；被试接口对已删除会话返回 410。
