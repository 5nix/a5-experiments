# 配置文件使用与格式

## 选择、导入与生效

后台“新建会话 → 实验配置文件”读取 [config/notifications](config/notifications) 中的JSON；选中文件和被试后创建会话。“准备与检查 → 被试预分配配置”可下载当前JSON，修改后导入。校验通过才保存并选中，新文件使用唯一名称，不覆盖同名文件；无效配置不写入，也不替换当前配置。

也可直接将有效JSON放入上述目录，再刷新后台。当前选择重启后保留；创建会话时重新读取所选文件。配置与材料都固定到会话快照，修改文件不改变已有会话。

首次启动默认源配置是 [participants.pilot.json](config/participants.pilot.json)，使用P01—P28；已有数据库继续保留其配置。participants.source.json仅为原工作簿（5组）历史来源，不再校验或使用。程序不自动分组或纠正分配。

## 预置文件

| 文件名模式 | 名单 |
| --- | --- |
| `28-participants.<模式>.json` | P01—P28，V1—V7各4人（循环拉丁方，见 [V2文档](docs/V2变更决策与PRD-2026-10-26.md) 第3节），并附同模式000调试配置 |
| `000.<模式>.json` | 仅000调试 |

两类各有以下三种模式，共六份文件。三份正式文件的编号、版本、任务条件及消息分配相同，只改变通知呈现方式。旧20人文件已删除。

| display_mode | 呈现行为 |
| --- | --- |
| `legacy_8500` | 无声，从设备双眼drawn事件记录时刻起显示11000毫秒 |
| `tone_8500` | 沿用内置通知音，从设备双眼drawn事件记录时刻起显示11000毫秒 |
| `confirm_until_ack` | 无声且不自动消失，收到主控确认立即收起，不追加倒计时 |

## JSON字段

| 字段 | 要求 |
| --- | --- |
| experiment_id / schema_version | 固定为f5-sh-pilot及字符串1.0 |
| config_name | 可选的下拉显示名称 |
| participants | 正式被试完整名单；仅调试文件可为空 |
| participant_id / version_label | 非空、不重复的字符串编号，保留前导零；版本标签可选 |
| stages | 恰好包含SH01—SH07，不缺少、不重复；实际顺序由任务材料决定 |
| condition | N-T0、N-T1、N-T2、A-T0、A-T1、A-T2或NONE |
| message_id | 类别、数字与任务组一致，如SH06的A条件使用A06；NONE必须为null |
| display_mode | 配置在每个stages条目上，可在同一被试内混合；省略时默认legacy_8500 |
| debug_participant | 可选的000配置，见下文；正式participants中禁止000 |

N为通知型消息，A为AI主动服务型消息；T0在补充资料首次实际呈现时触发，T1在第二单元首次实际呈现时触发，T2在第二单元休息页实际可见后5秒触发（未休息即提交则不触发）。NONE不发消息，不需要display_mode。条件分配与呈现模式相互独立；每种条件出现次数由实验设计确定。

以下是仅含001的完整示例；导入会替换当前名单。修改28人文件时须保留所有需要的被试。

```json
{
  "experiment_id": "f5-sh-pilot", "schema_version": "1.0",
  "config_name": "逐通知混合示例",
  "participants": [{
    "participant_id": "001", "version_label": "V1",
    "stages": [
      {"stage_id":"SH01","condition":"N-T0","message_id":"N01","display_mode":"legacy_8500"},
      {"stage_id":"SH02","condition":"N-T1","message_id":"N02","display_mode":"tone_8500"},
      {"stage_id":"SH03","condition":"A-T0","message_id":"A03","display_mode":"confirm_until_ack"},
      {"stage_id":"SH04","condition":"A-T1","message_id":"A04","display_mode":"legacy_8500"},
      {"stage_id":"SH05","condition":"N-T2","message_id":"N05","display_mode":"tone_8500"},
      {"stage_id":"SH06","condition":"A-T2","message_id":"A06","display_mode":"confirm_until_ack"},
      {"stage_id":"SH07","condition":"NONE","message_id":null}
    ]
  }]
}
```

旧API的会话级display_mode仅为兼容默认值，逐通知字段优先。`legacy_8500`、`tone_8500` 保留原名称以兼容配置文件，v10起新会话的固定时长实际为11000毫秒；须配套1.1.4显示端。旧快照可继续按8500毫秒执行。持续确认模式不设自动或确认后倒计时，其协议duration_ms兼容值不参与计时，导出auto_hide_after_ms为空。已撤回的confirm_8500不是有效新配置。source_ref/source_value/source_cell可用于追溯，不控制流程。

## 000与教程调试

以 [000.confirm_until_ack.json](config/notifications/000.confirm_until_ack.json) 为完整模板。顶层debug_participant使用与正式被试相同的stages结构，但身份须为 `participant_id="000"`、`debug=true`、`copied_from="001"`。预置000文件与系统默认000条件均为V2分配表V1列，覆盖全部7种条件；没有此字段的旧文件使用系统默认条件。更换000模式后须新建会话；同编号只允许一个未结束会话。

新会话教程为工具说明、休息练习；含confirm_until_ack时再加练习消息和须答对的理解题。000被试端和主试后台均可跳转（V2快照不再有组间休息目标）：

| 目标 | 页面 | 适用配置 |
| --- | --- | --- |
| TUTORIAL_INTRO | 工作台、草稿本和时间 | 全部 |
| TUTORIAL_REST | 第二单元休息说明与一次短休息练习 | 全部（V2快照） |
| TUTORIAL_NOTICE | 阅读并确认练习消息 | 含确认模式 |
| TUTORIAL_CHECK | 消息理解题 | 含确认模式 |
| INTRO | 正式情景导入 | 全部 |

目标按当前会话快照生成。跳回不会重发已发送的练习消息；重新完整练习需结束并新建000。主试跳转原因可空，正式被试不能自行跳转。教程、正式数据和手动通知的统计区分见 [API.md](API.md)。

## 休息参数

休息参数不在预分配JSON中，而在 `content/revisions.json` 的 `rest_settings`：duration_ms（30000，实际休息时长）、window_min_ms（30000，所有组U2首次实际显示后的禁止触发窗口）、window_min_ms_by_stage（当前为空，所有组统一30秒）、t2_delay_ms（5000）、show_countdown、reminder_text、tutorial_duration_ms等。修改后执行 `python scripts/build_task_content.py` 重建tasks.json，重启并新建会话生效，已有会话保留原快照；自检只要求休息时长为正、T2延迟小于休息时长、窗口下限不为负。

## 已阅读按钮与点击导出

“已阅读消息”仅移除悬浮提示，保留原有悬停效果。每次点击（含无通知空点、未绘制、重复/暂停时点击）记录notice_read_clicked，独立click_id防止网络重试重复计数。有效确认仍单独记录message_user_confirmed及设备confirmed/hidden。导出的notice_clicks.csv可直接查看点击墙钟、单调毫秒、页面、关联通知和判定结果；完整埋点见[API.md](API.md)的当前事件清单。教程、手动与正式数据分别标记。
