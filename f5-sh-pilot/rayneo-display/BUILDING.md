# Android构建与部署

版本要求以Gradle文件为准：JDK 21、Gradle 9.5.0、AGP 9.3.1、Android SDK 37、Build Tools 36.0.0，源码级别Java 17。Windows和macOS均有构建验证；不要求安装Android Studio、模拟器或NDK。

## 环境准备

安装对应架构的JDK和Android命令行工具，设置JAVA_HOME及ANDROID_HOME，安装SDK Platform、Build Tools和platform-tools并接受许可。Gradle Wrapper自动下载固定发行版，首次解析依赖需网络。工具与缓存不进入Git，local.properties如使用本机路径也不提交。

Windows本机环境信息位于仓库根目录 `.a5-local/build-environment.json`；不能把该机器的绝对路径当作其他机器的配置。路径包含中文而Android工具不兼容时，使用ASCII构建副本，构建前同步源码、资源和Gradle配置，避免误装旧产物。

## 构建与检查

在rayneo-display目录执行，Windows使用gradlew.bat替代./gradlew：

```sh
./gradlew :app:assembleDebug :app:lintDebug --console=plain
node scripts/verify-apk-runtime.mjs app/build/outputs/apk/debug/app-debug.apk
```

产物为app/build/outputs/apk/debug/app-debug.apk。应用版本为app/build.gradle.kts中的versionName/versionCode；当前为1.1.3 / 9。Gradle依赖排查可运行 `:app:dependencies --configuration debugRuntimeClasspath`。

| 依赖 | 维护要点 |
| --- | --- |
| MercuryAndroidSDK-v0.2.6.aar | 本地厂商二进制，无Maven POM；实际SDK版本0.2.6-20260310143142_94a01a90 |
| AppCompat / Core KTX | 1.6.1 / 1.10.1，提供AndroidX基础能力 |
| Lifecycle ViewModel KTX / Runtime KTX | 显式声明2.6.1，避免镜腿触控缺少ViewModelKt而崩溃 |
| Material Components | 1.10.0，提供主题及相关运行依赖 |

Mercury AAR的SHA-256为 `5d408e2c5d80e8ae746c42abbda50012b50617005adfeb397661bec9c9be2676`。运行类检查验证DEX实际类定义，不应以引用字符串替代打包验证。

## 包名、签名与安装

默认包名link.ironip.a5.rayneo。本机修复版使用独立包名，构建参数为：

```sh
./gradlew :app:assembleDebug :app:lintDebug -Pa5LocalRepair=true --console=plain
```

该参数生成link.ironip.a5.rayneo.localfix，名称为“A5 雷鸟显示（修复版）”。包名改变意味着不同应用数据区，不能视为原包的普通升级；首次迁移须备份并验证账本。后续升级使用同包名、同签名覆盖，不能清除数据。不要提交私钥或口令。

先结束会话和展示、停止服务，再备份电脑runtime及眼镜display.sqlite，核验SQLite完整性和未结束请求。使用apksigner验证产物与签名，再执行 `adb -s <设备> install -r <APK>`；启动器中的packageName、apkPath、apkSha256须匹配。升级后核对账本保留情况和三种模式能力，最后恢复服务。连接和验收步骤见 [RAYNEO.md](../RAYNEO.md)。

## 资源与样式验证

内置音频为app/src/main/res/raw/notification.wav：48kHz、16位、单声道PCM，约0.983秒。来源universfield-new-notification-018-363746.mp3裁去前导73ms，不改变音高、速度或主动增益；替换资源后须重新构建。

- 原MP3 SHA-256：`d9b387ef345d53a9020ffe0b963f3542a648fb3f9a4fe13e5ac924a5206db762`。
- 内置WAV SHA-256：`b94efd73c5f0813120e97cf2727e5261c19a718398bc96f6232dff9b58655d0e`。

APK解包后的res/raw/notification.wav应与源码资源哈希一致。声音启动成功不代表实际可听，须结合设备媒体音量现场确认。

qa/StyleRenderCheck.java用于独立QA应用离屏验证实际字体排版、换行、行高、遮罩、默认通知及全部刺激。QA不连接正式实验套接字、不改实验数据。显示参数与溢出规则集中维护于RAYNEO，修改显示逻辑时同步复核并进行真机验收。
