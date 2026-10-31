# f5-sl-pilot

SL（静态低负荷）Pilot实验，属于 [a5-experiments](../README.md)。与 [f5-sh-pilot](../f5-sh-pilot/README.md) 是同一实验的两个分项：7组14个任务单元（SL01—SL07）、T0/T1/T2眼镜消息、U2内被试自主休息、理解题与评价量表、教程与导出格式都与SH一致；区别是任务换成简单的四则运算与时间换算，**没有补充资料附件**，T0与休息窗口的规则也不同（见 [DECISIONS.md](DECISIONS.md)）。

代码在公共包 [@a5/desktop](../packages/a5-desktop) 与 [@a5/glasses](../packages/a5-glasses) 中，本目录只有SL的内容、预分配、文档和测试：

| 位置 | 内容 |
| --- | --- |
| `config/experiment.json` | 分项声明：`experiment_id`、任务组前缀SL、无附件 |
| `config/participants.pilot.json`、`config/notifications/` | 预分配P01—P28及各呈现模式的配置文件，沿用SH分配表，SL0x对应SH0x的条件与消息编号 |
| `content/tasks.json`、`content/stimuli.json` | 由 `scripts/build_task_content.py` 生成，**不要手改**；题目、答案、说明卡、消息与理解题都写在该脚本里 |
| `docs/` | 《执行单：f5-sl-pilot》（最终材料与规则）与《A5 SL任务pilot》原稿；两者不一致处以执行单为准 |
| `src/server.ts`、`src/doctor.ts` | 分项入口，设置分项目录后加载公共包 |
| `tests/` | 内容核对（按公式重新计算全部答案）与流程测试（T0/T1/T2、练习、评分、导出） |

## 启动与命令

需要Node.js 24+。仓库根目录执行 `npm ci`，用 `a5-experiments.bat` / `.command` 选择本实验，或：

```sh
npm run start --workspace=f5-sl-pilot      # 后台 http://127.0.0.1:5174/admin（SH占用5173，可同时运行）
```

在本目录内：

```sh
npm run typecheck
npm test
npm run doctor
python scripts/build_task_content.py       # 修改题目或规则后重建 content/*.json，只对新建会话生效
```

手动调试必须隔离数据：`PORT=5199 A5_RUNTIME_DIR=... A5_EXPORT_DIR=... node src/server.ts`，不要复用 `runtime/` 里的正式被试数据库。

## 与SH共用的部分

后台操作、配置文件格式、API、被试端界面、眼镜设备与APK、导出结构见SH的 [CONFIG](../f5-sh-pilot/CONFIG.md)、[API](../f5-sh-pilot/API.md)、[FRONTEND](../f5-sh-pilot/FRONTEND.md)、[RAYNEO](../f5-sh-pilot/RAYNEO.md)、[ARCHITECTURE](../f5-sh-pilot/ARCHITECTURE.md)；这些文档中的文件路径以 [ARCHITECTURE](../f5-sh-pilot/ARCHITECTURE.md) 的对照表为准。SL新增的导出字段与事件见 [DECISIONS.md](DECISIONS.md)。

同一副眼镜同一时间只能绑定一个活跃会话，SH与SL不能同时做真机会话；Mock预演不受影响。
