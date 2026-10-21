# HTTP接口与导出

业务状态、评分、消息调度和校验由服务端控制，前端仅呈现公开view并提交操作。content目录含正确答案，不公开为静态资源。实验规则见 [DECISIONS.md](DECISIONS.md)，JSON配置规则见 [CONFIG.md](CONFIG.md)。

## 入口与鉴权

- 主试直接访问/admin，后台API不要求管理员key。服务默认监听0.0.0.0。
- 被试入口为 `/experiment#session=<ID>&token=<凭据>`，被试API使用该会话的Bearer token。
- 生成恢复入口会轮换token，旧链接失效，进度不变。已删除会话的被试接口返回410。
- connection含connected和last_seen_at，被试最近十秒内有鉴权请求即视为连接。

## 主试API

| 方法与路径 | 请求或结果 |
| --- | --- |
| GET /api/health | 服务与适配器状态 |
| GET /api/admin/preflight | 材料、配置、自检和设备状态 |
| GET /api/admin/network | 当前网卡地址、本机入口及是否局域网监听 |
| GET /api/admin/qr?text= | 本机生成SVG二维码 |
| GET /api/admin/config | config、debug_participant、files、selected_file、adapter、interview_prompts |
| POST /api/admin/config | `{filename,config}`：校验后保存为唯一新文件并选中；兼容直接传完整配置对象 |
| POST /api/admin/config/select | `{filename}`：读取配置目录内文件，校验后切换 |
| GET /api/admin/device | adapter、设备审计、control |
| POST /api/admin/device/control | 主机与手动通知操作，见下文 |
| GET /api/admin/sessions | 未删除sessions及deleted_sessions摘要 |
| POST /api/admin/sessions | `{participant_id,config_file?}`，返回201及session_id、token、participant_url、view |
| GET /api/admin/sessions/:id | summary、view、debug_targets、assignment、interventions、入口及连接状态 |
| GET /api/admin/sessions/:id/events | 完整原始事件 |
| GET/POST /api/admin/sessions/:id/notes | `{category,text,stage_id?}`；category为interview/observation/anomaly |
| POST /api/admin/sessions/:id/control | `{action,reason,target?}`；reason可为空字符串；action为pause/resume/stop/skip_break/debug_jump/delete/restore |
| POST /api/admin/sessions/:id/access | 轮换被试token并返回恢复入口 |
| GET /api/admin/export[?session_id=] | 指定单次会话，或全部未删除会话的ZIP |

config_file在创建时重新读取，已有会话不受后来导入影响。同编号重复创建返回409；真实设备未就绪、忙碌或已绑定其他活跃会话也拒绝创建。内部兼容参数display_mode只为未逐条配置的通知提供默认值，界面不提供该选择器。

summary包含is_debug、display_mode（混合为mixed）、phase、status、paused、任务位置、作答进度、消息证据、device_id、available_actions及删除信息。客户端按available_actions呈现按钮，服务端仍校验权限和状态。

## 设备控制与手动通知

control返回enabled、working、package_name、最近错误、voice_guard、debug_notifications、audit及scrcpy状态。enabled表示守护意图，voice_guard.state=protected才表示指定包权限已读回验证，不代表系统已完全锁定。

| action | 附加字段 | 行为 |
| --- | --- | --- |
| probe / open / reconnect / scrcpy | — | 探测、打开显示端、重连USB或打开左眼监看 |
| host | enabled:boolean | 切换守护，显示保护期内拒绝变更权限 |
| notify | request_id:UUID、text、display_mode? | 发送1—500字手动通知，模式缺省legacy_8500 |
| confirm_notify | request_id | 收起已绘制的持续型手动通知 |

模式含义以CONFIG为准。手动通知可在会话进行中发送；眼镜忙碌或上一条未确认时拒绝，不覆盖、不排队。重复ID且内容/模式相同只返回原记录，冲突返回409。关联活跃会话的通知进入interventions并标记manual；无会话时保存在设备通知表。Mock拒绝真机控制。

## 被试view与操作

`GET /api/participant/sessions/:id` 返回公开view，本身不触发消息。常用字段为phase、page_token、title、paragraphs、fields、answer、tables、reveal、scratchpad、scene_time、message_confirmation、confirmation_enabled、is_debug、debug_targets及休息状态。

phase包括TUTORIAL_INTRO、TUTORIAL_NOTICE、TUTORIAL_CHECK、INTRO、CARD、UNIT、COMPREHENSION、RATINGS、BREAK、COMPLETED、ABORTED；暂停时view为PAUSED。教程分支和跳转目标见CONFIG。

字段类型为integer、money、time、single、multi、integer_or_na；multi提交字符串数组，其他类型提交字符串。字段必答且无预选，0合法；金额最多两位小数；时间支持一位/两位小时、全角数字及常见冒号，归一化后小时0—23、分钟00—59。实际选项和约束以本页fields为准，旧会话保留旧快照。

`POST .../commands` 请求为 `{command_id,page_token,action,client,...}`；client包含timestamp_iso、monotonic_ms、time_origin_ms、visibility_state及user_agent。

| action | 附加字段 | 行为 |
| --- | --- | --- |
| displayed | client.visibility_state=visible | 报告实际可见；正式T1及练习通知只在对应页面实际呈现后触发 |
| resume / blur | — | 记录页面恢复或失焦 |
| reveal / reveal_displayed | open:boolean / 可见证据 | 打开收起附件 / 报告E；点击不等于E |
| draft / submit | answer | 保存草稿 / 校验提交并推进；教程理解题必须答对 |
| scratchpad | text | 保存当前单元或教程的独立草稿本 |
| continue | — | 按当前阶段继续，休息未结束时拒绝 |
| skip_break | — | 允许时提前结束休息，保留实际时长 |
| jump | target | 仅000自行跳转；不重放已发消息 |

`POST .../confirm-message` 请求为 `{request_id,client?}`，使用同一会话token。只允许确认本会话已绘制的持续消息，跨页有效，重复确认幂等；结果未知可重试同一确认，不重发刺激。暂停或结束会话不可确认。确认后等待设备hidden再允许下一条触发。

旧快照图片使用 `GET .../assets/imageN.png`，只允许当前页或已展开资料中的图片。错误码：400格式、401凭据、403权限、404不存在、409页面/状态冲突、410已删除、413过大、415媒体类型、422内容校验、503设备或传输异常。网络重试须使用同一command_id和完全相同请求体。

## 时序与数据导出

浏览器完成两帧实际绘制后才报告displayed或reveal_displayed；U1提交后直接渲染U2。草稿与提交串行发送；轮询仅在phase/page_token变化时整页重绘，确认状态单独更新。被试网页不显示刺激正文，眼镜计时不由网页定时器控制。

导出manifest的schema_version为1.6，版本随实际产物读取。ZIP包括：

| 文件 | 内容 |
| --- | --- |
| events.jsonl | 原始事件及client/device证据 |
| trials.csv / surveys.csv | 正式任务作答、评分、完成时长、理解题与评价 |
| interventions.csv | 所有关联会话的通知、模式、来源、设备事件、确认与时长；data_kind区分formal/tutorial/manual |
| tutorial.csv | 教程事件、答题尝试及相关证据 |
| sessions.csv | 会话摘要、快照哈希、异常及教程开始/结束/时长/尝试数 |
| notes.csv | 访谈、观察、异常备注 |
| snapshots.json / manifest.json | 固定材料与配置、导出范围及时间语义 |

缺失data_kind的旧干预视为formal。教程和手动通知不进入正式题成绩或正式呈现完成率。全部导出包含000、未完成、同编号多次会话，排除已删除会话。

CSV使用UTF-8 BOM，公式前缀文本转义，未知时间为空。设备drawn、confirmed、hidden及cue_started/cue_failed保存原始时钟；仅同一clock_id可计算设备间隔。未同步时t_display/t_hide为空，t_ack只代表电脑收到接受应答。原始JSON保留原值。

## 已阅读按钮点击埋点（2026-10-20）

按钮仅移除title悬浮提示，保留原有悬停效果，始终可点击。每次DOM点击/键盘激活在任何异步操作前采集客户端timestamp_iso、monotonic_ms、time_origin_ms、visibility_state和user_agent，以独立click_id调用POST /api/participant/sessions/:id/read-notice-click（会话Bearer鉴权）。正文为click_id、page_token、visible_request_id、client。

服务器先落盘notice_read_clicked，再决定是否发送确认：confirmation_requested（请求确认，尚非设备成功证据）、ignored_no_pending（空点）、ignored_not_drawn、ignored_failed、ignored_already_confirmed、ignored_paused、ignored_session_ended。每次独立点击均记录；同一click_id的网络重试只记录一次，并绑定原确认目标，绝不误确认后来出现的另一条通知。点击表述已阅读，不视为真实注意起点。传输失败时首次点击事件仍保留，确认结果通过消息事件判定。

每条点击保留服务端timestamp_iso/elapsed_ms，客户端点击时钟原值，当前phase/页面token及是否匹配、当前任务/单元、客户端见到和服务端关联的通知编号、判定结果。导出schema1.6增加notice_clicks.csv，客户端时间独立列出；原始事件也在events.jsonl中。教程/手动/正式依旧以data_kind区分。旧confirm-message接口是直接确认，不用于统计所有UI点击；message_user_confirmed仍只记录每条通知首次有效确认意图。

## 当前事件清单（按代码核对）

| 类别 | 事件名与内容 |
| --- | --- |
| 会话与恢复 | session_created（快照/设备/配置）、server_restarted、app_resumed、app_blurred |
| 页面可见 | intro_displayed、card_displayed、unit_displayed、comprehension_displayed、ratings_displayed、break_displayed、completion_displayed、termination_displayed；客户端可见证据与页面token |
| 页面继续/单元转换 | intro_continue、card_continue、continue_clicked、unit_transition_started、stage_completed、session_completed |
| 附件与触发 | reveal_clicked（展开/收起）、reveal_displayed（E）、u2_displayed（T1触发依据）、F_candidate（SH05_U1首次完整提交候选） |
| 作答与评分 | answer_changed、submit_clicked、submission_recorded、submission_rejected、unit_scored |
| 理解与评价 | comprehension_submitted（答案及正确性）、ratings_submitted（四项评分） |
| 草稿本 | scratchpad_changed（内容变化）；目前没有独立的打开/关闭事件 |
| 阅读按钮 | notice_read_clicked（每次点击，包括误点与未触发原因）、message_user_confirmed（首次有效确认意图） |
| 消息派发 | message_scheduled、message_send_requested、message_send_accepted、message_failed、message_transport_error |
| 设备事件 | message_device_accepted、message_device_drawn、message_device_cue_started、message_device_cue_failed、message_device_confirmed、message_device_hidden、message_device_failed；保留设备墙钟/单调时间/clock_id |
| 兼容回执事件 | message_display_confirmed、message_hidden，仅适配器实际提供显示/消失时间时记录，不补造时间 |
| 教程 | tutorial_intro_displayed、tutorial_notice_displayed、tutorial_check_displayed、tutorial_intro_continue、tutorial_notice_continue、tutorial_answer_submitted（每次答案/正误）、tutorial_completed、tutorial_notification_scheduled |
| 手动通知 | manual_notification_scheduled及上述消息/设备事件；无会话时保留device_debug_requests与设备审计 |
| 休息 | break_started、break_completed、break_skipped（主体、剩余/实际/计划时长），以及上述break_displayed/continue_clicked |
| 主试操作与备注 | admin_intervention（含暂停/恢复/停止/入口轮换）、debug_jump、session_deleted、session_restored、note_saved |
| 全局设备/配置审计 | config_imported、device_status_changed、device_event_rejected、device_control（守护、探测、重连、手动通知、镜像及错误）；保存于settings/admin_audit/设备记录，不伪装成被试行为 |

新会话事件包含event_id、session_id、participant_id、stage_id/unit_id、condition、data_kind、is_debug、内容版本、服务端ISO时间与会话相对毫秒。旧记录可能缺少后来新增的字段，原始数据不回填。客户端时间仅有实际客户端证据时记录；电脑与眼镜时钟未同步，跨设备绝对时差不当作呈现或注意延迟。网络完全不可用时客户端会提示记录失败，未送达的数据不能宣称已经落盘。
