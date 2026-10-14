pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        google()
        mavenCentral()
        // Локальные aar-библиотеки вендора кассы (SDK АТОЛ Sigma) кладутся в app/libs
        flatDir { dirs("app/libs") }
    }
}

rootProject.name = "FoodFlow POS"
include(":app")
