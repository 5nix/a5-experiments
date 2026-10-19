# 接口

业务规则、评分、状态和时长都由服务端控制，前端只负责呈现和调用接口。不得把 `content/` 公开为静态资源，里面有正确答案和刺激全文。

## 鉴权

- **实验员**：入口为 `/admin#key=<凭据>`。前端把凭据存入 sessionStorage 并清除地址片段；请求带 `Authorization: Bearer <凭据>`。
- **被试**：入口为 `/experiment#session=<ID>&token=<凭据>`。生成恢复入口会作废旧 token，不重置进度。
- 服务只监听 127.0.0.1。后台凭据不得进入 localStorage、被试页面或日志。

## 实验员 API

| 方法与路径 | 说明 |
| --- | --- |
| GET /api/health | 无需鉴权；服务与 adapter 状态 |
| GET /api/admin/preflight | 材料哈希、配置、软件准备状态、adapter |
| GET/POST /api/admin/config | 读取或导入完整预分配 JSON（非法时返回 422，保留原配置）；GET 另含 debug_participant（000）、interview_prompts |
| GET /api/admin/device | 设备连接状态、最近 100 条状态变化与审计 |
| POST /api/admin/device/control | 管理员设备控制：`{action:"probe"\|"open"\|"reconnect"\|"scrcpy"}`；`{action:"host",enabled:boolean}`；`{action:"notify",request_id:UUID,text:string}` |
| GET /api/admin/sessions | `sessions` 与 `deleted_sessions` 的摘要 |
| POST /api/admin/sessions | `{ "participant_id": "001" }` → 201，返回 session_id、token、participant_url；同编号已有未结束会话时返回 409 |
| GET /api/admin/sessions/:id | summary、公开 view、预分配、消息请求与回执 |
| GET /api/admin/sessions/:id/events | 完整原始事件 |
| GET/POST /api/admin/sessions/:id/notes | 备注：category 为 interview / observation / anomaly，stage_id 可选 |
| POST /api/admin/sessions/:id/control | `{ action, reason }`；action 为 pause / resume / stop / skip_break / debug_jump（另传 target，仅 000）/ delete / restore；reason 必填 |
| POST /api/admin/sessions/:id/access | 生成恢复入口，旧 token 失效 |
| GET /api/admin/export[?session_id=] | ZIP。省略参数 = 本实验全部未删除会话（含 000、未完成、同编号多次）；指定参数 = 仅这一次会话 |

summary 主要字段：`is_debug`、`current_title`、`answered_fields/total_fields`、`reveal_observed`、`remaining_ms`、`message_status`、`message_evidence`（drawn / hidden / failed / null）、`delivery_source`、`device_id`、`available_actions`、`deleted*`。前端按 `available_actions` 显示操作按钮，权限仍由服务端校验。

`GET /api/admin/device` 另返回 `control`：守护开关 `enabled`、执行中 `working`、目标应用 `package_name`、最近操作及错误、独立通知 `debug_notifications`、控制审计 `audit`、`scrcpy.running/crop/error`。测试通知最长 500 字，固定展示 8500 ms；重复 request_id 相同正文只返回原记录，不再次发送，正文冲突返回 409。进行中会话或显示忙碌时拒绝独立通知，Mock 模式拒绝真机操作。恢复连接和唤醒只恢复控制链路，不补发任何消息。

## 被试 API

`GET /api/participant/sessions/:id` 返回当前公开 view。读取 view 本身不会触发任何显示事件，也不会返回答案或评分。

```json
{
  "phase": "UNIT", "page_token": "...", "stage_number": 1, "stage_count": 5,
  "title": "...", "paragraphs": ["..."],
  "tables": [{ "id": "table-01", "caption": "方案报价表", "columns": ["方案"], "rows": [["A"]] }],
  "fields": [{ "id": "plans", "label": "合格方案", "type": "multi", "options": [{ "value": "A", "label": "A" }], "exclusive_value": "NONE" }],
  "answer": {},
  "reveal": { "button_label": "方案筹备日期表.xlsx", "open": false, "observed": false, "paragraphs": [], "tables": [] },
  "scratchpad": { "label": "草稿本", "placeholder": "在这里记录你的思考...", "max_length": 20000, "text": "" },
  "scene_time": { "date": "11月6日 周五", "time": "10:00" },
  "is_debug": false, "debug_targets": [], "remaining_ms": 0, "can_continue": true, "can_skip_break": false
}
```

- **phase**：INTRO、CARD、UNIT、COMPREHENSION、RATINGS、BREAK、COMPLETED、ABORTED；人工暂停时为 PAUSED，恢复后 page_token 不变。
- **字段类型**：integer、money、time、single、multi、integer_or_na，全部必答、无预选。multi 为字符串数组，其余为字符串。
  - 0 是合法值；金额最多 2 位小数。
  - time 接受一位或两位小时、全角数字、常见冒号和空格，由服务端统一校验，小时 0—23、分钟 00—59。
  - SH05 选 NONE 时，两个剩余量填“不适用”。
- 旧快照的图片资料：`GET .../assets/imageN.png`，只返回当前页和已展开资料中的图片。

## 操作

`POST /api/participant/sessions/:id/commands`，请求体为 `{ command_id, page_token, action, client, ...附加字段 }`。其中 `client` = `{ timestamp_iso, monotonic_ms, time_origin_ms, visibility_state, user_agent }`。

| action | 附加 | 行为 |
| --- | --- | --- |
| resume / blur | — | 记录恢复或失焦 |
| displayed | visibility_state 须为 visible | 页面实际呈现后报告；U2 的 T1 只在这里触发 |
| reveal | open: bool | 打开或收起附件并返回内容；点击本身不算 E |
| reveal_displayed | visible | 附件实际呈现后报告 E，只记一次 |
| draft | answer | 保存原样草稿答案 |
| scratchpad | text | 保存当前单元的草稿本 |
| submit | answer | 校验、保存、评分，返回下一页 view（不含评分）；U1 未显示过附件时返回 422 |
| continue | — | INTRO→CARD、CARD→U1，或休息满时进入下一组 |
| skip_break | — | 允许时跳过休息，并记录实际与剩余时长 |
| jump | target | 仅 000；保留答案与消息去重 |

- **错误码**：400 格式、401 凭据、403 资料不可见、404 不存在、409 旧页面 / 暂停 / 状态冲突、410 已删除、413 请求过大、415 媒体类型、422 内容 / 必答 / 格式不符或休息未结束。
- **重试**：网络中断时用同一个 command_id 和完全相同的请求体重试；新的逻辑操作换新 ID。

## 必须保留的时序

1. 内容放入 DOM、页面可见并完成两次 requestAnimationFrame 后，才报告 displayed；附件同样在实际绘制后才报告 reveal_displayed。
2. U1 提交成功后立即渲染 U2，不加中间按钮、延时或加载动画。
3. 草稿、答案与提交经同一个串行队列发送，迟到的草稿不能写进下一页。
4. 被试页不绘制任何消息，不等待 8.5 秒，不发关闭或清屏指令。
5. 轮询只在 page_token 或 phase 变化时整页重绘。

## 导出

ZIP 包含 `events.jsonl`、`trials.csv`、`interventions.csv`、`surveys.csv`、`sessions.csv`、`notes.csv`、`snapshots.json`、`manifest.json`。

- CSV 为 UTF-8 BOM，未知时间留空，全部带 `is_debug`。
- interventions 含 `device_id` 与 `device_events`。`t_display` / `t_hide` 在没有时钟同步时为 null。
