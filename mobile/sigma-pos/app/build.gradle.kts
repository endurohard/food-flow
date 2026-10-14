plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.devtools.ksp")
}

android {
    namespace = "ru.foodflow.pos"
    compileSdk = 34

    defaultConfig {
        applicationId = "ru.foodflow.pos"
        // АТОЛ Sigma 7/8/10 поставляются на Android 7.1–11, поэтому minSdk 25
        minSdk = 25
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        // Базовый URL Kong по умолчанию; на устройстве меняется в настройках
        buildConfigField("String", "DEFAULT_API_BASE", "\"https://foodflow.local\"")
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // Подпись релиза задаётся через ~/.gradle/gradle.properties
            // (FF_KEYSTORE / FF_KEYSTORE_PASSWORD / FF_KEY_ALIAS / FF_KEY_PASSWORD)
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    signingConfigs {
        val ksPath = (project.findProperty("FF_KEYSTORE") as String?)
        if (ksPath != null && file(ksPath).exists()) {
            create("release") {
                storeFile = file(ksPath)
                storePassword = project.findProperty("FF_KEYSTORE_PASSWORD") as String?
                keyAlias = project.findProperty("FF_KEY_ALIAS") as String?
                keyPassword = project.findProperty("FF_KEY_PASSWORD") as String?
            }
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
        compose = true
        buildConfig = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }
    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.06.00")
    implementation(composeBom)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.3")
    implementation("androidx.activity:activity-compose:1.9.0")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // Навигация
    implementation("androidx.navigation:navigation-compose:2.7.7")

    // Локальная БД — основа offline-first
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    // Фоновая синхронизация очереди продаж
    implementation("androidx.work:work-runtime-ktx:2.9.0")

    // Сеть
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")

    // Шифрованное хранение токена и настроек
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // SDK кассы АТОЛ Sigma. Положи aar в app/libs — модуль фискализации
    // подхватит его рефлексией, сборка не падает, если файла нет.
    compileOnly(fileTree(mapOf("dir" to "libs", "include" to listOf("*.aar", "*.jar"))))
    runtimeOnly(fileTree(mapOf("dir" to "libs", "include" to listOf("*.aar", "*.jar"))))

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
}
