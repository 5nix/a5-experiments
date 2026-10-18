# 基础前端与核心服务接口

可视化Agent应先阅读DECISIONS.md及本文件，再替换public目录。业务规则、评分、状态和时长由服务端控制。不得直接把content目录公开为静态资源，其中包含正确答案和刺激全文。

## 鉴权与入口

实验员终端链接为 `/admin#key=<本机后台凭据>`。基础前端将其存入sessionStorage并去掉地址片段。每个实验员API请求带 `Authorization: Bearer <后台凭据>`。

创建/恢复被试会话后得到 `/experiment#session=<会话ID>&token=<会话凭据>`。被试API请求带该token，旧会话图片通过认证fetch读取再转为Blob URL；新会话使用文本表格。恢复入口会轮换凭据，使旧入口失效，不重置实验进度。

服务只绑定127.0.0.1，无跨域接口。不在localStorage或被试页面保存后台凭据，也不向被试显示实验条件、标准答案、消息全文或Mock日志。

## 实验员API

| 方法与路径 | 输入与结果 |
| --- | --- |
| GET /api/health | 无需鉴权；当前服务状态，不含配置或答案 |
| GET /api/admin/preflight | 材料来源哈希、默认配置、原表异常、软件准备状态 |
| GET /api/admin/config | 当前导入配置、单独的debug_participant（000）、适配器状态、访谈提示 |
| POST /api/admin/config | 完整预分配JSON；不自动修复、不随机分组；非法返回422并保持原配置 |
| GET /api/admin/sessions | 全部会话摘要 |
| POST /api/admin/sessions | `{ "participant_id": "001" }`；返回201、session_id、token、participant_url、初始view；同一被试已有活跃会话返回409 |
| GET /api/admin/sessions/:id | 会话摘要、公开view、预分配、消息请求/回执 |
| GET /api/admin/sessions/:id/events | 完整原始事件，仅后台可见 |
| GET /api/admin/sessions/:id/notes | note_saved事件及保存时间，包含全部追加记录 |
| POST /api/admin/sessions/:id/notes | `{ "category":"interview", "text":"记录", "stage_id":null }`；category为interview/observation/anomaly，stage_id可为SH01—SH05 |
| POST /api/admin/sessions/:id/control | `{ "action":"pause", "reason":"原因" }`；action为pause/resume/stop/skip_break/debug_jump，必须填写原因；debug_jump另传target且仅允许000 |
| POST /api/admin/sessions/:id/access | `{}`；生成恢复链接并废止旧会话凭据 |
| GET /api/admin/export?session_id=:id | ZIP下载；省略session_id则导出全部。文件同时保存在exports目录 |

## 被试API

`GET /api/participant/sessions/:id` 返回当前公开view，不产生新的显示触发，不包含答案或评分。基本结构：

```json
{
  "session_id":"...",
  "phase":"UNIT",
  "page_token":"...",
  "stage_number":1,
  "stage_count":5,
  "title":"题目",
  "paragraphs":["题干"],
  "fields":[{"id":"plans","label":"合格方案","type":"multi","required":true,"options":[{"value":"A","label":"A"}]}],
  "assets":[],
  "tables":[{"id":"table-01","caption":"方案报价表","columns":["方案","报价"],"rows":[["A","4.6"]],"source_ref":{}}],
  "scratchpad":{"label":"草稿本","placeholder":"您可以在这里输入任意内容...","max_length":20000,"text":""},
  "is_debug":false,
  "debug_targets":[],
  "can_skip_break":false,
  "answer":{},
  "reveal":{"button_label":"查看补充资料","open":false,"observed":false,"paragraphs":[],"assets":[],"tables":[]},
  "remaining_ms":0,
  "can_continue":true
}
```

phase为INTRO、CARD、UNIT、COMPREHENSION、RATINGS、BREAK、COMPLETED、ABORTED；人工暂停时公开view的phase为PAUSED。恢复不改变原页面token。UNIT U1提交后的新页面token即对应U2，无额外“下一题”。

字段类型：integer、money、time、single、multi、integer_or_na。所有字段必答，无预选值。multi为字符串数组，exclusive_value（例如NONE）与其他项互斥；其他类型用字符串输入。整数0不视为空。金额最多2位小数，时间接受H:mm或HH:mm，如6:23、6:00、6:09；支持半角/全角及常见冒号（:、：、﹕、︓、∶、꞉、ː）、全角数字和冒号两侧空格，服务端统一为当天分钟数，小时0—23、分钟00—59。保留raw_answer用于追溯原输入。SH05选择NONE时两个剩余量均填“不适用”。格式完整但错误的主任务仍可提交。

旧会话图片兼容：`GET /api/participant/sessions/:id/assets/image1.png`。仅允许当前页及已展开补充资料中的图像，其余返回403。图片来自会话快照，不能读取工作目录或未来任务的图片来预加载内容。

## 操作协议

`POST /api/participant/sessions/:id/commands`，Content-Type为application/json：

```json
{
  "command_id":"每次逻辑操作的新UUID",
  "page_token":"当前view的token",
  "action":"displayed",
  "client":{
    "timestamp_iso":"2026-10-19T00:00:00.000Z",
    "monotonic_ms":100,
    "time_origin_ms":1792368000000,
    "visibility_state":"visible",
    "user_agent":"浏览器标识"
  }
}
```

| action | 附加输入 | 行为 |
| --- | --- | --- |
| resume | client | 刷新、重新打开或恢复可见时记录客户端时钟与恢复 |
| blur | client | 窗口失焦记录 |
| displayed | client.visibility_state必须为visible | 当前页面实际呈现后报告。U2的T1只在这里触发，不在GET或U1提交接口触发 |
| reveal | open:true/false | 请求展开/收起资料并返回对应内容；点击本身不等于E |
| reveal_displayed | client.visibility_state=visible | 补充资料实际呈现后报告E；重复报告不重复触发 |
| draft | answer对象 | 保存当前原样草稿，允许尚未填完整的中间输入 |
| scratchpad | text字符串 | 所有10个主任务单元均配置scratchpad，可保存当前单元文本；纯文本、不评分，刷新恢复 |
| skip_break | 无 | 仅在未暂停的BREAK且允许跳过时执行，记录实际休息及剩余时间 |
| jump | target字符串 | 仅000可用，目标须在debug_targets中；生成新page_token并记录debug_jump |
| submit | answer对象 | 服务端校验完整性和格式、保存答案并评分，返回下一页公开view，不泄露评分 |
| continue | 无 | INTRO到CARD、CARD到U1，或休息满180秒后进入下一组CARD |

成功返回当前/下一页view。错误包含error与request_id：400为格式错误，401为凭据错误，403为资料不可见，404为不存在，409为旧页面/暂停/状态冲突，413为请求过大，415为媒体类型错误，422为内容/必答/格式或休息未结束。422提交不推进，提交尝试及拒绝原因仍会落盘。

## 必须保留的时序

1. 先把当前页文字和表格放入DOM，如为旧快照则等待图片decode完成，document.visibilityState为visible，完成浏览器绘制后报告displayed。基础实现使用两个requestAnimationFrame；服务端同时保存客户端证据与接收时间。
2. reveal点击先调用reveal取得资料，再实际渲染表格（旧图需解码），最后报告reveal_displayed。不可在点击时提前报告E。全部U1的题干要求查看资料，后端会检查这一项。
3. 草稿与提交通过一个串行操作队列发送，避免晚到的草稿覆盖新页面。网络中断重试必须复用同一command_id和完全相同请求；新的逻辑操作换ID。
4. U1提交成功就渲染返回的U2，实际显示后立即报告displayed。不得加中间按钮、固定延迟或加载演出。
5. 不在被试页面绘制消息刺激，不等待8.5秒结束，也不发关闭/清除命令。COMPREHENSION只展示理解题与选项，不展示消息原文或正确答案。
6. 休息按钮以remaining_ms显示倒计时，服务端再次检查时间。可按can_skip_break显示“跳过休息”，调用skip_break；不能通过continue绕过计时。最后一组返回COMPLETED。
7. 轮询GET检查人工暂停/结束。只有page_token或phase变化才整体重绘，避免打断输入；刷新从answer恢复答案、从scratchpad.text恢复计算草稿。

## 内容修改

`content/tasks.json`中每个unit持有title、paragraphs、tables、可选scratchpad、reveal、fields及scoring；assets仅兼容旧内容；scoring仅服务端使用。exact包含字段标准值；staffing包含岗位资格/开始时间和人员资格/到岗/缺席。所有字段ID及unit_id稳定，文案修改不影响状态机。

消息和理解题位于content/stimuli.json，以stage_id+message_id查找。配置导入会检查其题目/选项是否齐全；不会判断研究语义是否正确。最终文案由用户提供后替换，并增加content_version；已有会话不重载工作文件。

本地凭据、runtime、exports不得进入Git或前端静态目录。替换界面后至少执行TESTING.md中的浏览器冒烟步骤。

## 状态框、调试与导出

后台会话summary包含is_debug、copied_from、current_title、answered_fields/total_fields、reveal_observed、remaining_ms、message_status、last_event_type/at及available_actions。前端据available_actions开放干预按钮，后端仍独立校验权限。

000为系统保留编号，不允许导入为正式配置；由当前001动态派生，debug=true、copied_from=001。正式会话的debug_targets为空，伪造debug标志不赋予跳题权限。target可为INTRO、SH01_CARD、SH01_U1、SH01_U2、对应有效问卷/BREAK、COMPLETED，准确列表以当前view为准。跳转保留已填答案、草稿及发送去重，不自动重发消息。

全部CSV新增is_debug；sessions.csv另含copied_from、breaks_skipped、debug_jumps；trials.csv含scratchpad_text与scratchpad_changes。events.jsonl保留scratchpad_changed的原文、break_skipped实际/剩余时长及操作方、debug_jump来源/目标/操作方/原因。manifest含debug_session_ids，分析时可据此排除000。

## 虚拟桌面前端交接（2026-10-19用户要求）

- 全部10个主任务单元均可打开独立的记事本窗口，窗口名称为“草稿本”。当前基础HTML只用可展开面板演示接口；虚拟桌面中的窗口、入口与开关由前端Agent实现。
- 文本为空时显示灰色placeholder：“您可以在这里输入任意内容...”。提示不是实际内容，不写入草稿、不计作已填写，也不默认插入任何文本。名称和提示读取view.scratchpad配置，不硬编码在桌面组件中。
- 允许任意纯文本，用textarea.value/textContent呈现，不执行表达式或HTML。通过scratchpad命令串行保存；关闭窗口不清空文本，重新打开和刷新恢复scratchpad.text。沿用按单元保存，各任务均可使用；切题后读取相应单元草稿。
- 时间字段可换成支持键盘输入的时间选择器；初始值必须为空，不自动填当前时间或标准答案。无论控件如何显示，均须保留手动键入6：23、6:00、6:09等形式的能力，不能用HTML pattern拦截服务端已支持的冒号。禁止增加新的时间默认值或改变研究文案。
- 多会话使用各自的session_id、token、page_token；前端状态不得在不同被试之间共享。一个被试入口对应一个操作页面，避免同时在多个窗口作答同一会话。

当前本机服务支持多个独立被试会话，但只监听127.0.0.1。跨电脑并行访问和真实眼镜设备路由仍需后续硬件/部署配置；不能把多个软件会话理解为已经支持多副眼镜实测。不同实验须使用不同端口，并保留各自runtime/exports。
