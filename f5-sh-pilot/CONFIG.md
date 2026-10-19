# 被试预分配 JSON

后台入口：**准备与检查 → 被试预分配配置 → JSON 格式与导入说明**。点击“下载当前配置（JSON）”取得正在使用的完整配置，修改后通过同一页导入。

仓库初始配置为 [config/participants.pilot.json](config/participants.pilot.json)，包含 001—004。后台导入的配置保存在运行数据库中，下载按钮取得的是数据库中的当前配置；修改仓库文件不会覆盖已导入的配置。

## 可导入的最小示例

```json
{
  "experiment_id": "f5-sh-pilot",
  "schema_version": "1.0",
  "participants": [
    {
      "participant_id": "001",
      "version_label": "V1",
      "stages": [
        { "stage_id": "SH01", "condition": "N-T0", "message_id": "N01" },
        { "stage_id": "SH02", "condition": "N-T1", "message_id": "N02" },
        { "stage_id": "SH03", "condition": "A-T0", "message_id": "A03" },
        { "stage_id": "SH04", "condition": "A-T1", "message_id": "A04" },
        { "stage_id": "SH05", "condition": "NONE", "message_id": null }
      ]
    }
  ]
}
```

此示例只有 001；若导入，会替换现有完整名单。增加被试时复制 participants 中的对象，修改编号和分配，保留所有需要的被试。

## 字段与规则

| 字段 | 含义与格式 |
| --- | --- |
| experiment_id | 固定为 `f5-sh-pilot` |
| schema_version | 固定为字符串 `1.0` |
| participants | 非空的完整被试数组 |
| participant_id | 非空、不重复的字符串，如 `001`；保留前导零。`000` 为系统保留编号，不可导入 |
| version_label | 版本显示标签，如 `V1`，建议填写 |
| stages | 每人恰好包含 `SH01`—`SH05`，不可缺少或重复；呈现顺序由实验任务材料决定，不随此数组重排 |
| condition | `N-T0`、`N-T1`、`A-T0`、`A-T1`、`NONE` 五选一 |
| message_id | N/A 与条件类别一致，数字与任务组一致，如 `SH03` 的 A 条件使用 `A03`；`NONE` 必须为 JSON 的 `null` |
| source_ref / source_value / source_cell | 可选的来源追溯信息，不控制实验流程 |

N 为通知型消息，A 为 AI 主动服务型消息。T0 在补充资料首次实际展示时触发；T1 在第 2 单元首次实际展示时触发。NONE 不发送消息，也不展示该组消息理解题和四项评价。

系统不自动重新分配或纠正配置，只报告校验错误。当前校验不要求每种条件恰好出现一次；请按实验设计自行确定每名被试的分配。

## 生效范围

- 导入替换整份预分配，校验失败时保留原配置。
- 新建会话采用当前配置；已经创建的会话保留原快照，包括分配和题目内容。
- 系统从当前配置中的 001 派生调试编号 000；若名单没有 001，则不提供 000。
- 后台可为所有未删除会话执行题目跳转，需填写干预原因；被试前端只有 000 提供跳转入口。正式被试被后台跳转后仍是正式身份，导出不会被标成 000 或调试会话。
