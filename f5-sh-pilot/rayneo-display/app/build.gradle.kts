plugins { id("com.android.application") }
android {
    namespace = "link.ironip.a5.rayneo"
    compileSdk = 37
    defaultConfig {
        applicationId = "link.ironip.a5.rayneo"
        minSdk = 31
        targetSdk = 37
        versionCode = 1
        versionName = "1.0"
    }
    buildFeatures { viewBinding = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
dependencies {
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("androidx.core:core-ktx:1.10.1")
    implementation("com.google.android.material:material:1.10.0")
    implementation(files("libs/MercuryAndroidSDK-v0.2.6.aar"))
}
