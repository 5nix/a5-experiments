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
| POST /api/admin/sessions/:id/control | `{action,reason,target?}`；reason可为空字符串；action为pause/resume/stop/skip_break/remind_rest/debug_jump/delete/restore |
| POST /api/admin/sessions/:id/access | 轮换被试token并返回恢复入口 |
| GET /api/admin/export[?session_id=] | 指定单次会话，或全部未删除会话的ZIP |

config_file在创建时重新读取，已有会话不受后来导入影响。同编号重复创建返回409；真实设备未就绪、忙碌或已绑定其他活跃会话也拒绝创建。内部兼容参数display_mode只为未逐条配置的通知提供默认值，界面不提供该选择器。

summary包含is_debug、display_mode（混合为mixed）、phase、status、paused、任务位置、作答进度、消息证据、message_status、rest、device_id、available_actions及删除信息。客户端按available_actions呈现按钮，服务端仍校验权限和状态。

remind_rest只在被试处于U2、未暂停且本组未休息时出现，否则409；它记录rest_reminder_sent并让被试电脑显示固定提醒语，不发眼镜。skip_break只用于旧快照的组间休息。V2中T2组未发消息时message_status为awaiting_rest（等待休息）或t2_not_triggered（未休息即提交）。summary.rest（V2快照的正式任务页，否则null）含status（not_in_u2/before_window/available/requested/resting/returning/rested/not_rested）、u2_elapsed_ms、window_min_ms、remaining_ms、reminder_count、last_reminder_at、after_reminder、rest_started_at、t2（非T2组为null；awaiting_rest/scheduled/sent/failed/not_triggered）及t2_due_in_ms。

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

`GET /api/participant/sessions/:id` 返回公开view，本身不触发消息。常用字段为phase、page_token、title、paragraphs、fields、answer、tables、reveal、scratchpad、scene_time、message_confirmation、confirmation_enabled、is_debug、debug_targets、旧快照组间休息状态及rest。

view.rest仅在V2快照的U2和TUTORIAL_REST出现，其余为null：key（组号或TUTORIAL）、button_label、state（idle/requested/resting/returning/done）、title、paragraphs、show_countdown、duration_ms、remaining_ms、countdown_started、feedback（窗口前或重复点击的提示 `{id,text}`）、reminder（`{id,text,display_ms,displayed}`）。view不暴露窗口下限和T2计划。

phase包括TUTORIAL_INTRO、TUTORIAL_REST、TUTORIAL_NOTICE、TUTORIAL_CHECK、INTRO、CARD、UNIT、COMPREHENSION、RATINGS、BREAK（仅旧快照）、COMPLETED、ABORTED；暂停时view为PAUSED。教程分支和跳转目标见CONFIG。

字段类型为integer、money、time、single、multi、integer_or_na；multi提交字符串数组，其他类型提交字符串。字段必答且无预选，0合法；金额最多两位小数；时间支持一位/两位小时、全角数字及常见冒号，归一化后小时0—23、分钟00—59。实际选项和约束以本页fields为准，旧会话保留旧快照。

`POST .../commands` 请求为 `{command_id,page_token,action,client,...}`；client包含timestamp_iso、monotonic_ms、time_origin_ms、visibility_state及user_agent。

| action | 附加字段 | 行为 |
| --- | --- | --- |
| displayed | client.visibility_state=visible | 报告实际可见；正式T1及练习消息只在对应页面实际呈现后触发 |
| resume / blur | — | 记录页面恢复或失焦 |
| reveal / reveal_displayed | open:boolean / 可见证据 | 打开收起附件 / 报告E；点击不等于E |
| draft / submit | answer | 保存草稿 / 校验提交并推进；教程理解题必须答对 |
| scratchpad | text | 保存当前单元或教程的独立草稿本 |
| continue | — | 按当前阶段继续；旧快照休息未结束、或TUTORIAL_REST未完成练习时拒绝 |
| skip_break | — | 仅旧快照：允许时提前结束组间休息，保留实际时长 |
| rest_click | — | 点击休息按钮，每次都记录；窗口前/已休息只返回feedback，否则进入requested |
| rest_displayed | client.visibility_state=visible | 报告休息页实际可见，休息与T2计划由此起算；重复回报不重置 |
| rest_return_displayed | — | 倒计时到零后报告回到U2可见，结束本次休息 |
| rest_reminder_displayed | reminder_id | 报告主试提醒已在电脑显示，同一提醒只记一次 |
| jump | target | 仅000自行跳转；不重放已发消息 |

`POST .../confirm-message` 请求为 `{request_id,client?}`，使用同一会话token。只允许确认本会话已绘制的持续消息，跨页有效，重复确认幂等；结果未知可重试同一确认，不重发刺激。暂停或结束会话不可确认。确认后等待设备hidden再允许下一条触发。

旧快照图片使用 `GET .../assets/imageN.png`，只允许当前页或已展开资料中的图片。错误码：400格式、401凭据、403权限、404不存在、409页面/状态冲突、410已删除、413过大、415媒体类型、422内容校验、503设备或传输异常。网络重试须使用同一command_id和完全相同请求体。

## 时序与数据导出

浏览器完成两帧实际绘制后才报告displayed或reveal_displayed；U1提交后直接渲染U2。草稿与提交串行发送；轮询仅在phase/page_token变化时整页重绘，确认状态单独更新。被试网页不显示刺激正文，眼镜计时不由网页定时器控制。

导出manifest的schema_version为2.0，版本与文件列表以实际manifest为准。ZIP包括：

| 文件 | 内容 |
| --- | --- |
| events.jsonl | 原始事件及client/device证据 |
| trials.csv / surveys.csv | 正式任务作答、评分、完成时长、理解题与评价 |
| interventions.csv | 所有关联会话的通知、模式、来源、设备事件、确认与时长；data_kind区分formal/tutorial/manual |
| tutorial.csv | 教程事件、答题尝试及相关证据 |
| sessions.csv | 会话摘要、快照哈希、异常及教程开始/结束/时长/尝试数 |
| notes.csv | 访谈、观察、异常备注 |
| notice_clicks.csv | 已阅读按钮每次点击 |
| rests.csv | V2每组一行休息记录（含未休息）：开始/结束、实际时长、暂停、开始时作答进度与答案快照、距U2出现/窗口开放/U2提交、是否提醒后 |
| rest_clicks.csv | 每次休息按钮点击及判定（含窗口前与重复点击） |
| rest_reminders.csv | 主试提醒的时间、组/单元、提醒语与显示回报 |
| stage_summary.csv | 每组一行：条件、消息与T2状态、休息时间点、是否提醒后、理解题第1题、是否跳过量表 |
| breaks.csv | 仅旧快照的组间休息 |
| snapshots.json / manifest.json | 固定材料与配置、导出范围及时间语义 |

缺失data_kind的旧干预视为formal。教程和手动通知不进入正式题成绩或正式呈现完成率。全部导出包含000、未完成、同编号多次会话，排除已删除会话。

CSV使用UTF-8 BOM，公式前缀文本转义，未知时间为空。设备drawn、confirmed、hidden及cue_started/cue_failed保存原始时钟；仅同一clock_id可计算设备间隔。未同步时t_display/t_hide为空，t_ack只代表电脑收到接受应答。原始JSON保留原值。

## 已阅读按钮点击埋点（2026-10-20）

按钮仅移除title悬浮提示，保留原有悬停效果，始终可点击。每次DOM点击/键盘激活在任何异步操作前采集客户端timestamp_iso、monotonic_ms、time_origin_ms、visibility_state和user_agent，以独立click_id调用POST /api/participant/sessions/:id/read-notice-click（会话Bearer鉴权）。正文为click_id、page_token、visible_request_id、client。

服务器先落盘notice_read_clicked，再决定是否发送确认：confirmation_requested（请求确认，尚非设备成功证据）、ignored_no_pending（空点）、ignored_not_drawn、ignored_failed、ignored_already_confirmed、ignored_paused、ignored_session_ended。每次独立点击均记录；同一click_id的网络重试只记录一次，并绑定原确认目标，绝不误确认后来出现的另一条通知。点击表述已阅读，不视为真实注意起点。传输失败时首次点击事件仍保留，确认结果通过消息事件判定。

每条点击保留服务端timestamp_iso/elapsed_ms，客户端点击时钟原值，当前phase/页面token及是否匹配、当前任务/单元、客户端见到和服务端关联的通知编号、判定结果。导出增加notice_clicks.csv，客户端时间独立列出；原始事件也在events.jsonl中。教程/手动/正式依旧以data_kind区分。旧confirm-message接口是直接确认，不用于统计所有UI点击；message_user_confirmed仍只记录每条通知首次有效确认意图。

## 当前事件清单（按代码核对）

| 类别 | 事件名与内容 |
| --- | --- |
| 会话与恢复 | session_created（快照/设备/配置）、server_restarted、app_resumed、app_blurred |
| 页面可见 | intro_displayed、card_displayed、unit_displayed、comprehension_displayed、ratings_displayed、break_displayed、completion_displayed、termination_displayed；客户端可见证据与页面token |
| 页面继续/单元转换 | intro_continue、card_continue、continue_clicked、unit_transition_started、stage_completed、session_completed |
| 附件与触发 | reveal_clicked（展开/收起）、reveal_displayed（E）、u2_displayed（T1触发依据）、F_candidate（SH05_U1首次完整提交候选） |
| 作答与评分 | answer_changed、submit_clicked、submission_recorded、submission_rejected、unit_scored |
| 理解与评价 | comprehension_submitted（两题答案及内容题正确性）、ratings_submitted（五项评分）、comprehension_skipped与ratings_skipped（跳过原因） |
| 草稿本 | scratchpad_changed（内容变化）；目前没有独立的打开/关闭事件 |
| 阅读按钮 | notice_read_clicked（每次点击，包括误点与未触发原因）、message_user_confirmed（首次有效确认意图） |
| 消息派发 | message_scheduled、message_send_requested、message_send_accepted、message_failed、message_transport_error |
| 设备事件 | message_device_accepted、message_device_drawn、message_device_cue_started、message_device_cue_failed、message_device_confirmed、message_device_hidden、message_device_failed；保留设备墙钟/单调时间/clock_id |
| 兼容回执事件 | message_display_confirmed、message_hidden，仅适配器实际提供显示/消失时间时记录，不补造时间 |
| 教程 | tutorial_intro_displayed、tutorial_rest_displayed、tutorial_rest_continue、tutorial_notice_displayed、tutorial_check_displayed、tutorial_intro_continue、tutorial_notice_continue、tutorial_answer_submitted（每次答案/正误）、tutorial_completed、tutorial_notification_scheduled |
| 手动通知 | manual_notification_scheduled及上述消息/设备事件；无会话时保留device_debug_requests与设备审计 |
| U2休息与T2 | rest_clicked（disposition：too_early/rest_requested/already_resting/already_rested）、rest_started（作答进度、答案快照、是否提醒后）、rest_t2_planned、rest_t2_due、rest_countdown_ended、rest_ended（实际/计划时长、暂停）、rest_interrupted（跳转等）、rest_not_taken、t2_not_triggered；T2发送失败仍为message_failed（timing=T2及原因） |
| 主试提醒 | rest_reminder_sent（提醒语、U2已进行时间、序号）、rest_reminder_displayed |
| 旧组间休息 | break_started、break_completed、break_skipped（主体、剩余/实际/计划时长），以及上述break_displayed/continue_clicked |
| 主试操作与备注 | admin_intervention（含暂停/恢复/停止/入口轮换）、debug_jump、session_deleted、session_restored、note_saved |
| 全局设备/配置审计 | config_imported、device_status_changed、device_event_rejected、device_control（守护、探测、重连、手动通知、镜像及错误）；保存于settings/admin_audit/设备记录，不伪装成被试行为 |

新会话事件包含event_id、session_id、participant_id、stage_id/unit_id、condition、data_kind、is_debug、内容版本、服务端ISO时间与会话相对毫秒。旧记录可能缺少后来新增的字段，原始数据不回填。客户端时间仅有实际客户端证据时记录；电脑与眼镜时钟未同步，跨设备绝对时差不当作呈现或注意延迟。网络完全不可用时客户端会提示记录失败，未送达的数据不能宣称已经落盘。

### 任务包后的问卷数据（内容版本v7起）

信息识读理解题的提交为 `{ message_notice, answer }`，两项独立必答。`message_notice` 的值为 `not_noticed`（没有注意到任何消息）、`partially_read`（注意到了消息，但没有完整读到消息内容）或 `fully_read`（完整读到了消息内容）；`answer` 仍为当前消息内容题的 A/B/C 选项。第1题题干为“刚才这组任务中（包括休息时），你注意到眼镜上的消息了吗？”（2026-10-29起），三个选项取值不变，前两项标签的“提示”于2026-10-29改为“消息”；第1题不联动第2题，也不参与内容题判分。`comprehension_submitted` 事件同时保存两项答案，`correct` 只依据内容题原正确选项计算。

量表提交保存五个1—7分整数：`timing`（时机）、`attention_distraction`（分散注意力）、`thought_disruption`（扰乱思路）、`task_interference`（妨碍继续完成任务）、`perceived_disturbance`（感到被打扰）。题目、端点和说明随内容快照固定；草稿沿用原有页面草稿机制。

`surveys.csv` 增加 `message_notice` 和上述新量表字段；历史的 `disruption`、`effort`、`helpfulness` 列保留用于旧会话，不将旧题答案映射为新题答案。旧会话缺失的新字段导出为空，原始事件与会话快照不回填。现有 NONE 组处理和页面顺序不变。新配置仅用于新建会话。

内容版本v8起，快照中的 `survey_pages.ratings.skip_if_not_noticed=true` 启用条件跳转。只有理解页两题通过校验并保存后，`not_noticed` 才跳过量表，`partially_read`、`fully_read` 进入量表；草稿改选不跳转，内容题正误与C选项均不影响跳转。跳过后进入下一组说明卡（旧快照为组间休息）或完成。没有该开关的历史快照保持原有流程。

未注意到提示而跳过时，先记录 `comprehension_submitted`，再记录 `ratings_skipped`（`reason=not_noticed`、消息ID和注意情况）。无消息组在U2提交后记录 `comprehension_skipped`、`ratings_skipped`，两者均为 `reason=no_message`；T2未触发组同样记录两者，`reason=t2_not_triggered` 并带消息ID，不会生成虚假的问卷回答。上述事件及最终状态在同一个事务中保存，失败时整体回滚，重复提交不重复记录。

`surveys.csv` 的 `ratings_status` 区分 `submitted`、`skipped`、`pending`，另有 `ratings_skip_reason` 和 `ratings_skipped_at`。跳过量表时各评分及 `ratings_submitted` 留空，不能当作0分；无消息组只在 `events.jsonl` 记录跳过原因，保持不生成问卷行。

### 组间休息（内容版本v9—v10，V2起取消，仅旧快照）

`content/tasks.json` 的 `break_ms=30000`、`break_start_on_display=true`；生成来源是 `content/revisions.json` 的 `break_settings`。本组所有必填问卷提交后只进入待显示的休息页，收到可见的 `displayed` 命令才记录 `break_displayed` 并启动倒计时。问卷填写与显示前等待不计入休息。刷新或重复显示回执不重置计时，未满30秒的继续请求被拒绝；倒计时完成后按钮为“开始下一任务”。原有跳过与人工暂停规则保留，U1至U2衔接和消息、问卷跳转规则不变。

`break_started`、`break_completed`、`continue_clicked`、`break_skipped` 通过 `break_id`（对应页面令牌）关联。`breaks.csv` 每次已显示的休息一行，包含 `displayed_at`、`countdown_ended_at`、`continue_clicked_at` 及 `actual_rest_ms`。实际时长为会话单调时间的显示至继续/跳过间隔，不封顶为30000毫秒；未点击时留空。提前跳过单独记主体、原因和剩余时间，不伪造完成。

`countdown_ended_at` 是倒计时逻辑到零的时间，`completion_observed_at` 是服务端实际检测到零的时间；延迟轮询或重启不会把后者误作前者。人工暂停冻结倒计时并顺延到零时刻，实际休息间隔包含暂停和到零后等待。客户端显示与点击时间证据分别保留在 `display_client`、`continue_client`，服务端ISO时间和单调毫秒数同时保存。旧会话按原内容快照执行，历史缺失的字段不回填。

### 消息固定时长与隐藏原因（内容版本v10、显示端1.1.4起）

两种固定策略的新请求为 `duration_ms=11000`，保持 `legacy_8500`、`tone_8500` 策略标识及原有无声/有声设置。Android先记录双眼 `drawn`，再以该事件的设备单调时间加11000安排隐藏；`hidden` 在双眼内容清除绘制后记录。持续确认策略忽略协议duration_ms兼容值，不设置自动隐藏或确认后倒计时，确认收到后立即清除画面，声音配置不变。旧请求8500毫秒仍可由新版显示端按旧快照执行。

设备事件增加 `display_mode`、`duration_ms` 和 `hide_reason`，后者仅在hidden时赋值，至少区分 `auto_timeout` 与 `user_confirmed`，取消/故障另记原因。`interventions.csv` 另列 `auto_hide_after_ms`（确认策略为空）、`device_drawn_wall_ms`、`device_drawn_monotonic_ms`、`device_hidden_wall_ms`、`device_hidden_monotonic_ms`、`hide_reason`、`device_confirmed_wall_ms`、`device_confirmed_monotonic_ms`。用户主机确认时刻仍保存于 `confirmation_requested_at`，设备确认事件则单独保存；不混用两端时钟。实际显示时长继续只用同一设备clock_id下的drawn至hidden差值，历史原因缺失时留空，不按模式猜测。

### U2自主休息与T2（内容版本v11起）

`tasks.json` 的 `in_unit_rest` 由 `revisions.json` 的 `rest_settings` 生成：duration_ms=30000、window_min_ms=30000（所有组统一，window_min_ms_by_stage为空）、t2_delay_ms=5000、提示与提醒文案、show_countdown、reminder_display_ms、tutorial_duration_ms。窗口按U2首次实际呈现计算，未满30秒只记录点击并提示，满30秒可发起休息；T2计划时刻=rest_started的elapsed_ms+t2_delay_ms，暂停时与休息截止一起顺延。rest_* 事件以rest_id关联，主试提醒以reminder_id关联；教程休息记为data_kind=tutorial。此设置随新会话快照固定，旧快照沿用原阈值。
