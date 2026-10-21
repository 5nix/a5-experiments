# 浏览器验证脚本

这里保留Playwright场景脚本，不属于npm run check。部分脚本仍假定无教程的旧流程、旧字段或唯一.btn.subtle选择器，运行前须核对当前API和界面；不能直接作为当前版本全流程通过的依据。当前验证范围及手动检查清单见 [TESTING.md](../../TESTING.md)。

## 隔离环境

单独安装Playwright，使用本机Google Chrome。服务必须使用独立端口、A5_RUNTIME_DIR、A5_EXPORT_DIR，不连接正式被试数据库；截图输出目录同样独立。

```sh
PORT=5174 A5_RUNTIME_DIR=/tmp/a5-qa-runtime A5_EXPORT_DIR=/tmp/a5-qa-exports \
  npm run start --workspace=f5-sh-pilot
```

| 环境变量 | 用途与默认值 |
| --- | --- |
| A5_BASE | 服务地址，http://127.0.0.1:5174 |
| A5_PLAYWRIGHT | 可导入的Playwright模块路径，默认playwright |
| A5_QA_OUT | 截图及报告目录，默认/tmp/a5-qa |
| PID | 脚本支持时使用的被试编号，具体以脚本为准 |

旧脚本的001—004依赖独立测试夹具，并非默认P01—P20名单。使用前核对配置和旧脚本导入方式；不要为让脚本通过而修改正式预分配或绕过确认规则。

## 场景索引

| 脚本 | 可复用的检查范围 |
| --- | --- |
| flow.mjs | 任务、问卷、休息与导出；需先适配教程分支 |
| participant-checks.mjs / attachment.mjs | 草稿、附件、必答、输入归一化和刷新恢复 |
| timestamps.mjs | 事件格式、可见证据、时长、排期与导出 |
| scene-clock.mjs / scene-clock-flash.mjs | 情境时间切换及刷新不重复闪烁；旧隐藏规则须更新 |
| admin.mjs / admin-import.mjs | 后台操作、配置导入；须适配文件下拉、可选原因和新控件 |
| stop-active.mjs | 结束目标服务全部活跃会话，仅可用于隔离测试环境 |

脚本使用通用按钮选择器时，新增已阅读按钮可能造成歧义，应按功能区域和名称定位。新建会话会进入教程，不能固定假定第一个“下一步”后已是说明卡；确认模式的理解题必须答对。

Mock只能验证软件，不生成真机绘制证据。真机模式须先确认设备就绪，再用独立000数据检查三种模式及故障路径；消息重复、重启恢复和未知时间的约束不可为测试放宽。局域网访问须另用实际手机验证。
