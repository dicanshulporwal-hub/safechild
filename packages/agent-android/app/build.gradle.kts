import java.io.ByteArrayOutputStream

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

fun getGitCommit(): String {
    return try {
        val stdout = ByteArrayOutputStream()
        project.exec {
            commandLine("git", "rev-parse", "HEAD")
            standardOutput = stdout
        }
        stdout.toString().trim()
    } catch (e: Exception) {
        System.getenv("SAFEBROWSE_BUILD_COMMIT")
            ?: System.getenv("BUILD_COMMIT")
            ?: System.getenv("GITHUB_SHA")
            ?: "unknown"
    }
}

android {
    namespace = "com.safebrowse.child"
    compileSdk = 34

    val defaultProdApiBaseUrl = "https://safebrowse.porwal.online"
    val defaultDevApiBaseUrl = "http://10.0.2.2:11002"
    val safebrowseApiBaseUrl: String = (project.findProperty("safebrowseApiBaseUrl") as? String)
        ?: System.getenv("SAFEBROWSE_API_BASE_URL")
        ?: defaultProdApiBaseUrl
    val gitCommit = getGitCommit()

    defaultConfig {
        applicationId = "com.safebrowse.child"
        minSdk = 26
        targetSdk = 34
        versionCode = 5
        versionName = "1.0.4-validation"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "SAFEBROWSE_API_BASE_URL", "\"$safebrowseApiBaseUrl\"")
        buildConfigField("String", "BUILD_COMMIT", "\"$gitCommit\"")
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
                ?: System.getenv("SAFEBROWSE_DEV_API_URL")
                ?: defaultDevApiBaseUrl
            buildConfigField("String", "SAFEBROWSE_API_BASE_URL", "\"$devUrl\"")
            buildConfigField("String", "BUILD_COMMIT", "\"$gitCommit\"")
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("pilot")
            buildConfigField("String", "SAFEBROWSE_API_BASE_URL", "\"$safebrowseApiBaseUrl\"")
            buildConfigField("String", "BUILD_COMMIT", "\"$gitCommit\"")
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
