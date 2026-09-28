import java.security.MessageDigest

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.safebrowse.child"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.safebrowse.child"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        manifestPlaceholders["appLabel"] = "SafeBrowse Child"
    }

    signingConfigs {
        create("pilot") {
            val pilotKsFile = file("../pilot.keystore")
            val debugKsFile = file("${System.getProperty("user.home")}/.android/debug.keystore")
            val customKsPath = System.getenv("ANDROID_PILOT_KEYSTORE_PATH")

            if (customKsPath != null && file(customKsPath).exists()) {
                storeFile = file(customKsPath)
                storePassword = System.getenv("ANDROID_PILOT_KEYSTORE_PASSWORD") ?: "safebrowse"
                keyAlias = System.getenv("ANDROID_PILOT_KEY_ALIAS") ?: "cert"
                keyPassword = System.getenv("ANDROID_PILOT_KEY_PASSWORD") ?: "safebrowse"
            } else if (pilotKsFile.exists()) {
                storeFile = pilotKsFile
                storePassword = System.getenv("ANDROID_PILOT_KEYSTORE_PASSWORD") ?: "safebrowse"
                keyAlias = System.getenv("ANDROID_PILOT_KEY_ALIAS") ?: "cert"
                keyPassword = System.getenv("ANDROID_PILOT_KEY_PASSWORD") ?: "safebrowse"
            } else if (debugKsFile.exists()) {
                storeFile = debugKsFile
                storePassword = "android"
                keyAlias = "androiddebugkey"
                keyPassword = "android"
            }
            enableV1Signing = true
            enableV2Signing = true
        }
    }

    buildTypes {
        debug {
            val devUrl = (project.findProperty("safebrowseDevApiUrl") as? String)
                ?: (project.findProperty("safebrowseApiBaseUrl") as? String)
                ?: System.getenv("SAFEBROWSE_DEV_API_URL")
                ?: System.getenv("SAFEBROWSE_API_BASE_URL")
                ?: "http://10.0.2.2:11002"
            buildConfigField("String", "SAFEBROWSE_API_BASE_URL", "\"$devUrl\"")
            buildConfigField("String", "ENVIRONMENT", "\"development\"")
            manifestPlaceholders["appLabel"] = "SafeBrowse Dev"
        }
        create("pilot") {
            initWith(getByName("release"))
            matchingFallbacks += listOf("release")
            val pilotUrl = (project.findProperty("safebrowsePilotApiUrl") as? String)
                ?: (project.findProperty("safebrowseApiBaseUrl") as? String)
                ?: System.getenv("SAFEBROWSE_PILOT_API_URL")
                ?: System.getenv("SAFEBROWSE_API_BASE_URL")
                ?: "http://100.88.17.16:11002"
            buildConfigField("String", "SAFEBROWSE_API_BASE_URL", "\"$pilotUrl\"")
            buildConfigField("String", "ENVIRONMENT", "\"pilot\"")
            manifestPlaceholders["appLabel"] = "SafeBrowse Pilot"
            signingConfig = signingConfigs.getByName("pilot")
        }
        release {
            isMinifyEnabled = false
            val prodUrl = (project.findProperty("safebrowseProdApiUrl") as? String)
                ?: System.getenv("SAFEBROWSE_PROD_API_URL")
                ?: "https://api.safebrowse.io"
            buildConfigField("String", "SAFEBROWSE_API_BASE_URL", "\"$prodUrl\"")
            buildConfigField("String", "ENVIRONMENT", "\"production\"")
            manifestPlaceholders["appLabel"] = "SafeBrowse"
            signingConfig = signingConfigs.getByName("pilot")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        viewBinding = true
        buildConfig = true
    }
}

tasks.register("packagePilotApk") {
    dependsOn("assemblePilot")
    doLast {
        val buildApk = file("build/outputs/apk/pilot/app-pilot.apk")
        val releaseDir = file("../../../release/android")
        releaseDir.mkdirs()
        val targetApk = file("$releaseDir/SafeBrowseChild-Pilot.apk")
        val legacyApk = file("$releaseDir/safebrowse-child-pilot.apk")
        val rootApk = file("../../../SafeBrowseChild-Pilot.apk")

        if (buildApk.exists()) {
            buildApk.copyTo(targetApk, overwrite = true)
            buildApk.copyTo(legacyApk, overwrite = true)
            buildApk.copyTo(rootApk, overwrite = true)

            val md = MessageDigest.getInstance("SHA-256")
            val bytes = targetApk.readBytes()
            val hash = md.digest(bytes).joinToString("") { b -> "%02x".format(b) }

            file("$targetApk.sha256").writeText("$hash  SafeBrowseChild-Pilot.apk\n")
            file("$legacyApk.sha256").writeText("$hash  safebrowse-child-pilot.apk\n")
            file("$rootApk.sha256").writeText("$hash  SafeBrowseChild-Pilot.apk\n")
            println("✅ Generated SafeBrowseChild-Pilot.apk (SHA-256: $hash)")
        } else {
            throw GradleException("Pilot APK output not found at ${buildApk.absolutePath}")
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.work:work-runtime-ktx:2.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.google.code.gson:gson:2.10.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.0")
    testImplementation("junit:junit:4.13.2")
}
