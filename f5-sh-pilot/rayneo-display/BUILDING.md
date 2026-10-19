# Android 构建依赖与本机安装

本项目使用共享的 Java／Android 命令行开发环境。工具安装在当前用户目录，其他项目可以复用；仓库保存版本要求和 Gradle Wrapper，不保存 JDK、Android SDK 或构建缓存。

## 版本与来源

| 组件 | 版本／要求 | 用途与声明位置 |
| --- | --- | --- |
| JDK | 本机安装 Amazon Corretto 21 LTS，21.0.12.12.1，macOS ARM64 | 运行 Gradle、Java 编译；应用源码级别为 Java 17 |
| Android 命令行工具 | 包版本 23.0，ARM64；内含 Android CLI | 安装／管理 Android SDK |
| Android SDK Platform | API 37.0，`platforms;android-37.0` | `app/build.gradle.kts` 的 compileSdk/targetSdk 37 |
| Android Build Tools | 36.0.0（AGP 9.3.1 默认） | APK 打包、DEX、签名等 |
| Android Gradle Plugin | 9.3.1 | 根 `build.gradle.kts` |
| Gradle | 9.5.0 | `gradle/wrapper/gradle-wrapper.properties`，下载校验和已固定 |
| ADB | SDK Platform Tools 37.0.1；终端继续使用已有 Homebrew adb | 部署和 USB 转发，构建 APK 不需要连接设备 |
| Mercury SDK | 0.2.6-20260310143142_94a01a90 | `app/libs/MercuryAndroidSDK-v0.2.6.aar` |
| AndroidX AppCompat | 1.6.1 | `app/build.gradle.kts` |
| AndroidX Core KTX | 1.10.1 | `app/build.gradle.kts` |
| AndroidX Lifecycle ViewModel KTX / Runtime KTX | 2.6.1 | 厂商 AAR 的显式运行依赖；触控 ViewModel 需要 `ViewModelKt` |
| Material Components | 1.10.0 | `app/build.gradle.kts`，提供应用主题及相关 AndroidX 依赖 |

Mercury AAR 是参考程序提供的厂商二进制，没有 Maven POM；SHA-256 为 `5d408e2c5d80e8ae746c42abbda50012b50617005adfeb397661bec9c9be2676`。已从 `debugRuntimeClasspath` 确认其运行依赖随 APK 打包：Kotlin stdlib 2.2.10、kotlinx-coroutines-android/core 1.6.4。这些由 AGP 和 AndroidX 依赖图解析；排查 SDK 运行问题时应同时检查依赖图与设备日志。

## 本机共享目录

| 内容 | 位置 |
| --- | --- |
| JDK | `~/Library/Java/JavaVirtualMachines/amazon-corretto-21.jdk/` |
| `JAVA_HOME` | 上述目录下的 `Contents/Home`，由 `/usr/libexec/java_home -v 21` 查找 |
| Android SDK／`ANDROID_HOME` | `~/Library/Android/sdk/` |
| Android CLI | `$ANDROID_HOME/cmdline-tools/latest/bin/android` |
| Gradle 发行版与 Maven 缓存 | `~/.gradle/` |
| shell 配置 | `~/.zprofile` 内标记的“Android 与 Java 命令行开发环境”配置段 |
| 修改前的 shell 配置备份 | `~/.zprofile.before-android-20261019` |

没有安装 Android Studio、模拟器或 NDK。没有向 `/Library` 或 `/usr` 写入工具。此安装对当前 macOS 用户的其他项目可用，不是所有系统用户的管理员级安装。

新开登录终端即可加载环境；已有终端执行：

```sh
source ~/.zprofile
java -version
javac -version
android --version
android sdk list
adb version
```

`java` 也可通过 macOS 的标准 JDK 发现机制使用。项目不写死本机用户名或绝对 SDK 路径。若另一项目需要不同 JDK，可为其单独设置 `JAVA_HOME`。

## 在另一台 macOS 机器准备环境

从 [Corretto 官方下载页](https://docs.aws.amazon.com/corretto/latest/corretto-21-ug/downloads-list.html) 安装适合芯片架构的 JDK 21，从 [Android 官方下载页](https://developer.android.com/studio#command-tools) 获取命令行工具。解压后的 `bin`、`lib`、`source.properties` 等应放在 `$ANDROID_HOME/cmdline-tools/latest/` 下。

```sh
export JAVA_HOME="$(/usr/libexec/java_home -v 21)"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
android sdk install 'platforms;android-37.0'
android sdk install 'build-tools;36.0.0'
android sdk install 'platform-tools'
```

按官方工具提示接受所需 SDK 许可。Windows 使用同样的 JDK／SDK／Gradle 版本，在用户环境变量中设置 `JAVA_HOME`、`ANDROID_HOME` 及 PATH，通过 `gradlew.bat` 构建。Windows 尚未实机验证。

## 构建与产物

在本文件所在目录执行：

```sh
./gradlew :app:assembleDebug --console=plain
```

Windows PowerShell：

```powershell
.\gradlew.bat :app:assembleDebug --console=plain
```

APK：`app/build/outputs/apk/debug/app-debug.apk`。这是开发调试签名，正式分发签名另行配置；不要把 keystore 或签名口令提交到仓库。

构建后检查 APK 中实际定义的运行类（不是仅检查 DEX 中出现的引用字符串）：

```sh
node scripts/verify-apk-runtime.mjs app/build/outputs/apk/debug/app-debug.apk
```

## Windows 真机修复记录（2026-10-19）

preview.2 真机日志确认：镜腿触控进入厂商 `TempleActionViewModel` 时，缺少 `androidx.lifecycle.ViewModelKt`，导致 `NoClassDefFoundError`、应用退出及 USB 显示连接中断。原 AAR 没有 Maven POM，不能依赖 AndroidX 的间接依赖来补齐厂商的运行需求。现已显式声明 ViewModel KTX 和 Runtime KTX 2.6.1，版本提升为 1.0.1 / 2。

本机 Windows 构建使用 JDK 21、SDK Platform 37.0、Build Tools 36.0.0、AGP 9.3.1 与 Gradle 9.5.0。工具及 ASCII 构建目录位于 `E:/A5Build/`；源码仍在原项目目录。构建及 `lintDebug` 已通过，APK 签名校验、运行类定义检查通过。

发布包没有原作者的调试签名私钥，因此本机使用以下参数生成独立修复版，保留原应用与其数据：

```sh
gradle :app:assembleDebug :app:lintDebug -Pa5LocalRepair=true --console=plain
```

此参数将安装包 ID 设为 `link.ironip.a5.rayneo.localfix`，应用名为“A5 雷鸟显示（修复版）”。协议、业务 ID 和设备绑定规则保持一致。未传参数时仍构建原包 ID，正式更新需要原签名私钥。

本机已先备份原设备 `display.sqlite` 并核验 SQLite 完整性，再迁移至首次安装的修复版；迁移前后 SHA-256 一致。旧版保留并停用，避免再次误开旧版或占用同一个 USB 协议端口。电脑端本机启动入口已绑定修复版。设备账本和电脑端实验数据不进入源码或公开报告。

Gradle Wrapper 会自动获取固定版本的 Gradle，无需另行全局安装 `gradle`。首次构建需联网从 Google Maven、Maven Central 获取依赖；后续复用 `~/.gradle/`。排查依赖时执行 `./gradlew :app:dependencies --configuration debugRuntimeClasspath`。

## 1.0.2 消息样式构建与验证

2026-10-19 消息样式更新为 **1.0.2 / versionCode 3**。固定显示参数见 [RAYNEO.md](../RAYNEO.md)。`qa/StyleRenderCheck.java` 可在独立 QA 应用中离屏验证实际 Android 字体排版、15/16 字换行、1–6 行行高、全部实验消息、遮罩像素和超长正文拒绝，不需要启动实验显示 Activity，也不连接实验协议或修改实验数据。本机构建脚本为 `.a5-local/build-message-style.ps1`，生成独立包 `link.ironip.a5.rayneo.styleqa`；验证脚本为 `.a5-local/check-message-style.mjs`。17 组绘制检查通过，焦点前后一致。正式 APK 的 assembleDebug、lintDebug、签名和 Lifecycle 运行类定义检查通过。

## 1.0.3 固定亮度构建

2026-10-19，显示窗口亮度固定为 `1.0f / 6.0f`，创建及恢复前台时应用；版本为 **1.0.3 / versionCode 4**。macOS 上执行 `./gradlew :app:assembleDebug -Pa5LocalRepair=true --console=plain` 成功，生成 `link.ironip.a5.rayneo.localfix` 修复版 APK。本次未运行测试、未部署真机；约 1000 nits 仅是以最高 6000 nits 为前提的线性估算。

## 1.0.4 行尾空白误判修复

2026-10-19，版本提升为 **1.0.4 / versionCode 5**。后台默认测试通知在设备上被误报 `device_text_does_not_fit`：`StaticLayout.getLineWidth()` 包含自动换行处的行尾空格，该行统计为 260.08 px。边界校验改用排除行尾空白的 `getLineMax()`，字号、宽度、行高、正文与亮度设置保持原值，仍拒绝实际正文超宽或总高度不足。

Windows assembleDebug、lintDebug、APK 签名及 Lifecycle 必需运行类检查通过。独立 Android 离屏回归共 18 组通过，包括完整默认测试通知；同签名覆盖安装，设备账本哈希一致。安装后用后台真实接口复测原文，双眼三行绘制、8515 ms 后消失，无失败。证据在本机 `.a5-local/qa-message-style/fit-fix/`。

## 仓库与磁盘维护

提交 Gradle 配置、Wrapper、应用源码、厂商 AAR 和本说明。`.gitignore` 已排除 `.gradle/`、`build/`、`local.properties`；本机 SDK 路径不应提交。安装包校验后可删除下载压缩包，工具目录继续保留。Gradle 缓存随其他项目使用增长；如需释放空间，先 `./gradlew --stop`，再有针对性地清理可重新下载的缓存，勿删除眼镜实验 runtime 或设备去重数据。

## 本次构建记录

2026-10-19，macOS ARM64：`./gradlew :app:assembleDebug :app:lintDebug --console=plain` 成功，APK 签名校验成功。Lint 0 错误、6 警告。安装压缩包及未使用的 Build Tools 37.0.0 已清理；实际使用 Build Tools 36.0.0。工具与 Gradle 缓存合计约 1.83 GiB，首次构建输出另约 39 MiB；共享缓存会随使用增长。没有真机运行结论。
