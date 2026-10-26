# 雷鸟眼镜接入与维护

适用链路为Windows主机、USB ADB和一副指定序列号的雷鸟X3 Pro；显示应用使用Mercury SDK原生双眼View。当前APK源码版本为1.1.4，实际部署须核对构建文件、安装包和设备能力，不能只看文档版本。

## 首次接入与更换设备

1. 安装匹配的ADB驱动，眼镜开启USB调试，并在设备端允许当前电脑。使用数据线连接，确认 `adb devices` 中状态为device。
2. 安装显示APK并打开应用，空闲纯黑属于正常状态；媒体音量须能听到提示音。
3. 按 [公共启动器说明](../scripts/README.md) 配置项目内platform-tools、scrcpy及 `.a5-local/device.json`，启动真机模式，检查后台“显示端就绪”。
4. 用000及手动通知检查双眼文字、音频、确认和消失，再进入正式会话。

更换同款眼镜也须重新完成驱动识别、USB调试授权、APK安装和设备绑定。先结束原会话、停止服务，修改device.json的serial为新设备序列号；或移除旧serial，在仅连接一副已授权设备时让启动器重新绑定。不能把已有真机会话转到新设备或Mock。

原包ID为link.ironip.a5.rayneo，本机修复版为link.ironip.a5.rayneo.localfix。A5_RAYNEO_PACKAGE必须与安装包一致。构建、签名与覆盖安装见 [BUILDING.md](rayneo-display/BUILDING.md)。卸载或清除数据会丢失去重账本；升级应同签名覆盖并保留数据，正式会话期间不部署。

## 运行配置

通用服务默认Mock；配置本机设备后的Windows启动器走真机且不回退。直接启动可在PowerShell设置：

```powershell
$env:A5_GLASSES_MODE = 'rayneo'
$env:A5_RAYNEO_SERIAL = '<设备序列号>'
$env:A5_ADB_PATH = '<adb.exe完整路径>'
$env:A5_RAYNEO_PACKAGE = 'link.ironip.a5.rayneo.localfix'
npm run start --workspace=f5-sh-pilot
```

A5_SCRCPY_PATH指定完整scrcpy可执行文件，相关DLL和server文件须齐全。A5_RAYNEO_HOST_MODE=off仅改变守护初始默认值；后台保存的设置优先。路径和设备配置不提交Git。

## 控制与守护

后台“准备与检查 → 眼镜与显示端”提供探测、唤醒打开、USB重连、守护、手动通知和scrcpy。手动通知允许在会话进行中发送，模态和数据归属见 [API.md](API.md)。忙碌时拒绝新消息，不覆盖、不排队。

守护按秒检查，恢复命令至少间隔5秒；失联或离开前台时尝试唤醒并拉回指定应用。展示及发送保护期不切前台、不重建隧道、不修改权限，也不重播刺激。物理断线、未授权或系统拦截仍须处理具体原因，守护不能替代连接和授权。

语音覆盖防护仅按包限制com.rayneo.aispeech的SYSTEM_ALERT_WINDOW，不停用Launcher或共享系统UID。原权限先持久备份，设置后读回验证，关闭守护或安全退出时恢复。退出最多等待15秒，设备仍忙或恢复失败时保留备份及诊断。已发生的失焦继续记录失败；这不是设备所有者锁定模式。

scrcpy独立使用 `--serial <设备> --crop 640:480:0:0 --no-audio` 监看左眼并可调试触控，不承担刺激发送。

## USB协议与证据

ADB通过 `forward tcp:0 localabstract:a5-rayneo-v1` 建立持久TCP连接，每行一个JSON，protocol为a5-rayneo/1。设备仅接受shell/root UID连接，一次只允许一个刺激控制端。

| 命令 | 主要字段与结果 |
| --- | --- |
| status | ready、busy、ledger_id及device_info.display_modes |
| show | 业务ID、device_id、text、固定模式duration_ms=11000（兼容旧快照8500）、可选display_mode；返回去重状态、正文哈希及双眼layout。确认模式忽略duration_ms |
| confirm | request_id、device_id；确认持续消息并立即收起，重复确认幂等 |
| cancel | request_id、device_id；结束会话时取消持续消息并留痕 |
| events | after序号，每批最多25条 |

支持的display_modes为legacy_8500、tone_8500、confirm_until_ack，模式语义见 [CONFIG.md](CONFIG.md)。设备先落盘accepted，双眼完成绘制后记drawn；固定时长模式独立计时后收起，持续模式等待confirmed，再由双眼清除回调记录hidden。音频播放启动/失败分别为cue_started/cue_failed。

1.1.4固定策略的自动隐藏截止时刻为账本drawn事件的device_monotonic_ms加11000毫秒，不从发送、接受、服务端回执或提示音播放起算。hidden事件保留实际双眼清除绘制时间，并记录hide_reason：auto_timeout（自动到时）、user_confirmed（用户确认）、experiment_stopped（实验取消）等；不将异常取消混作正常自动隐藏。策略、绘制、隐藏与设备确认时间另列导出，旧事件缺失原因时留空。持续确认策略没有隐藏定时器，确认命令收到后直接清除显示，提示音资源、音量、焦点及播放逻辑未修改。

单次RPC上限3秒，引擎等待上限5秒，事件后续轮询回收。传输超时、进程重启或失焦不证明“未显示”，不自动重发。设备按request_id永久去重，同ID不同内容拒绝。

设备原始wall、monotonic和clock_id保留；未与电脑同步，不直接换算显示ISO时间。drawn/hidden仅为应用层证据，cue_started不证明可听见，confirmed不等于注意起点。正式验收标准见 [TESTING.md](TESTING.md)。

## 显示与音频参数

| 项目 | 当前设置 |
| --- | --- |
| 角度换算与字体 | 27 PPD，0.6°即16.2px，Medium 500，字距0.02em |
| 正文宽与内边距 | 最大9.55°，整数布局宽257px；四周0.5°即13.5px |
| 行高 | 1—4行135%（21.87px），5行及以上150%（24.3px） |
| 位置与颜色 | 卡片居中、正文左对齐；白字和白色35%圆角遮罩，外部黑底 |
| 溢出 | 固定字号，不缩字、不截断；实际不适配则报device_text_does_not_fit |
| 窗口亮度 | 固定1/6；以6000nits线性估算约1000nits，未经光学标定 |

提示音为内置res/raw/notification.wav，48kHz、16位、单声道PCM。由用户提供MP3裁去前导73ms后转码，时长约0.983秒；SoundPool启动时预加载，在drawn后以媒体音量播放一次，不循环。资源哈希及检查方法见BUILDING。静音、加载或启动失败必须保留cue_failed。

## 1.1.3 提示音热修复（2026-10-20）

P03反馈SH02 T0开始无声、T1有声；原会话SH02/SH03均有accepted/drawn/cue_started/hidden，只能确认软件调用，不能证明被试听到。000按P03原分配复现可见双眼文字。1.1.2尝试的registerFrameCommitCallback在此Mercury镜像渲染环境未回调，造成有文字但不进入drawn/声音路径；1.1.3已撤回该等待，恢复双眼onDraw后回调，再执行提示音及独立8500ms计时。

T0和T1共用playCue：申请瞬时音频焦点，不等待延迟焦点；静音、未加载、焦点拒绝/丢失、播放失败分别留cue_failed，启动成功仍只记cue_started。显示应用前台持有有超时的亮屏唤醒锁，暂停/销毁释放；就绪包含交互和屏幕ON。隐藏超时保留失败并释放忙碌，不伪造hidden。电脑在T0展开/T1提交前阻止未就绪触发，恢复后用户重试原操作，旧通知不补发。

用户要求停止继续测试后，仅编译并同签名安装1.1.3，保留账本，未再次发送测试通知。真实听感未作最终验收，不能宣称历史漏通知原因已完全确认。禁止再用未经此设备验证的帧提交等待阻断声音。
