plugins {
    id("com.android.application")
    kotlin("android")
}

android {
    namespace = "com.httpgateway.dialer"
    compileSdk {
        version = release(36) {
            minorApiLevel = 1
        }
    }
    buildToolsVersion = "36.1.0"

    defaultConfig {
        applicationId = "com.httpgateway.dialer"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        val defaultWsUrl = providers.gradleProperty("GATEWAY_WS_URL")
            .orElse("ws://10.0.2.2:8787/v1/device-channel")
            .get()
        buildConfigField("String", "DEFAULT_GATEWAY_WS_URL", "\"${defaultWsUrl.replace("\"", "\\\"")}\"")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation(project(":protocol"))
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // In-app wireless ADB: pairs with this phone's own adbd to launch the shell-UID audio server.
    implementation("com.github.MuntashirAkon:libadb-android:3.1.1")
    implementation("org.conscrypt:conscrypt-android:2.5.3")
    implementation("org.lsposed.hiddenapibypass:hiddenapibypass:6.1")
    implementation("org.bouncycastle:bcpkix-jdk15to18:1.81")
    // QR pairing with the admin console (Google code scanner: no camera permission needed).
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
}
