# 架构与数据流

## 模块职责

| 位置 | 职责 |
| --- | --- |
| src/server.ts | 启动、监听、运行目录、定时轮询与正常停止 |
| src/app.ts | HTTP路由、被试token、静态白名单与CSP |
| src/engine.ts | 状态机、快照、校验、调度、确认及操作去重 |
| src/store.ts | SQLite事务、状态、只追加事件及干预记录 |
| src/config.ts / config-files.ts | JSON校验、目录扫描、选择和导入落盘 |
| src/tasks.ts | 内容载入、输入归一化与评分 |
| src/export.ts | CSV、JSONL、快照、清单和ZIP |
| src/adapters/ | Mock与雷鸟USB适配器 |
| src/device-control.ts / voice-overlay-guard.ts | 主机恢复、手动通知、scrcpy及语音覆盖防护 |
| content/ / config/ | 材料、修订及预分配，均不直接公开为静态资源 |
| public/ | 原生ES module；被试端与后台样式隔离 |
| rayneo-display/ | Android双眼显示、音频、设备去重账本 |

Node.js 24+使用内置SQLite；其他运行依赖见package.json。公共启动器管理进程生命周期，不介入实验规则。

## 状态与服务端权威

新建HTTP会话先进入教程（TUTORIAL_INTRO、TUTORIAL_REST，确认模式另有TUTORIAL_NOTICE/CHECK），再进入INTRO、CARD、UNIT、COMPREHENSION、RATINGS及终态；本组结束直接进入下一组CARD。内容快照含 `in_unit_rest` 才启用V2休息；没有它的旧快照仍走BREAK组间休息。完整分支见 [DECISIONS.md](DECISIONS.md)。暂停保留底层阶段，通过view呈现PAUSED。直接使用Engine的内部调用可保留无教程的兼容路径。

每页具有page_token，旧页面不能提交；command_id与完整请求指纹用于操作去重。评分和正确答案只在服务端，公开view不包含答案。配置文件在创建请求中重新读取，防止多个主试页面切换配置时使用错误预分配；已有会话继续使用其快照。

## 持久化与时钟

SQLite启用WAL、synchronous=FULL及外键。状态、事件和发送意图在事务中保存；事件表与设备原始事件禁止更新或删除。会话删除仅写state.deleted，默认读取和全部导出排除它，被试接口返回410。

elapsed_ms由服务器单调时钟计算，暂停期间仍累计，休息截止时间与T2计划时刻相应顺延。重启取持久化时长与墙钟跨度的较大值续接并记录server_restarted。浏览器可见证据、服务器接收时间和设备原始时间分别保存，不把电脑与眼镜时钟直接相减。

## U2休息状态

休息状态按组保存在 `state.rests`（教程键为TUTORIAL），依次为 requested（已点击、待休息页可见）→ resting（rest_displayed后起算）→ returning（倒计时到零）→ done（回到U2可见）。休息中服务端拒绝草稿、提交、附件和草稿本操作（409）；跳转会中断进行中的休息并记rest_interrupted。窗口下限按U2首次实际呈现时刻计算。主试提醒保存在 `state.rest_reminders`，被试端显示后回报rest_reminder_displayed。

## 消息生命周期

1. 实际可见事件触发正式消息；教程与手动通知使用独立请求。
2. 先保存request_id和发送意图，再异步调用适配器，不阻塞答题。
3. 接受回执和后续设备事件按request_id、设备身份合并；迟到事件仍落原请求。
4. 确认按消息归属校验，跨页有效，重复确认不重播。下一条触发前检查待确认或仍在显示的通知。

T2由引擎在休息页可见时排定（rest_t2_planned），到期由tick和精确定时器触发（rest_t2_due）；第5秒眼镜不可用则直接记失败，不排队。U2提交时仍未发送则记t2_not_triggered，不补发。

重启时未完成的发送标为unknown，不重放。设备另有永久去重账本；任一端超时都不能据此推断未显示。协议与显示计时见 [RAYNEO.md](RAYNEO.md)。

## 数据类别与主机控制

interventions中的data_kind区分formal、tutorial、manual，旧记录缺省formal；教程和手动消息不计正式呈现完成率。无会话的手动通知保存于device_debug_requests，其事件优先路由到该表。导出结构见 [API.md](API.md)。

DeviceControl复用唯一适配器；ADB只负责连接、前台及权限生命周期。展示保护期不拉前台、不改权限、不重建隧道。守护设置和原权限备份持久化，操作进入admin_audit。关闭服务先等待控制任务和有限的展示保护窗口，再关闭适配器与数据库，并回收自身scrcpy进程。
