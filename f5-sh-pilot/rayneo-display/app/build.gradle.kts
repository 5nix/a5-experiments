plugins { id("com.android.application") }
val localRepair = providers.gradleProperty("a5LocalRepair").map(String::toBoolean).getOrElse(false)
android {
    namespace = "link.ironip.a5.rayneo"
    compileSdk = 37
    defaultConfig {
        applicationId = if (localRepair) "link.ironip.a5.rayneo.localfix" else "link.ironip.a5.rayneo"
        minSdk = 31
        targetSdk = 37
        versionCode = 10
        versionName = "1.1.4"
        resValue("string", "app_name", if (localRepair) "A5 雷鸟显示（修复版）" else "A5 雷鸟显示")
    }
    buildFeatures { viewBinding = true; resValues = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
dependencies {
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("androidx.core:core-ktx:1.10.1")
    // 本地 Mercury AAR 没有 POM；镜腿触控使用 ViewModelKt，必须显式打包其 KTX 运行依赖。
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.6.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.6.1")
    implementation("com.google.android.material:material:1.10.0")
    implementation(files("libs/MercuryAndroidSDK-v0.2.6.aar"))
}
