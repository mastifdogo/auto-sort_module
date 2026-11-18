plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The app has its own version (appVersion in android/gradle.properties), apart from the module's:
// the app came from the Import module (last app there: 0.21.1), which is merged into Auto sort, and
// Android only installs an update with a higher version than the app it replaces. Raise appVersion
// whenever the app changes; every release of the module attaches the app as it then is.
val appVersion: String = providers.gradleProperty("appVersion").get()
val parts = appVersion.split(".").map { it.toInt() }

// Release builds are signed with the key GitHub holds (see README: "The phone app").
// The same key every time, or Android refuses to install an update over the app.
val keystorePath: String? = System.getenv("APP_KEYSTORE_FILE")

android {
    namespace = "app.ledger.importer"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.ledger.importer"
        minSdk = 26
        targetSdk = 35
        versionCode = parts[0] * 1_000_000 + parts[1] * 1_000 + parts[2]
        versionName = appVersion
        // Where the app finds its updates (Updater.kt): the releases of the Auto sort module.
        buildConfigField("String", "RELEASES_REPO", "\"mastifdogo/auto-sort_module\"")
        buildConfigField("String", "APK_NAME", "\"ledger-import.apk\"")
        // The module the app sends receipts to: /api/v1/m/categorizer/inbox (Auto sort 0.17.0 or newer).
        buildConfigField("String", "MODULE_ID", "\"categorizer\"")
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("APP_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("APP_KEY_ALIAS")
                keyPassword = System.getenv("APP_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystorePath != null) signingConfig = signingConfigs.getByName("release")
        }
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
    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    // Finds the receipt in the camera, straightens it and makes the PDF (Google Play services).
    implementation("com.google.android.gms:play-services-mlkit-document-scanner:16.0.0-beta1")
}
