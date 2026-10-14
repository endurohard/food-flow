# Room / Kotlin serialization
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class kotlinx.serialization.json.** { *; }
-keep,includedescriptorclasses class ru.foodflow.pos.**$$serializer { *; }
-keepclassmembers class ru.foodflow.pos.** {
    *** Companion;
}
-keepclasseswithmembers class ru.foodflow.pos.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# SDK кассы подключается рефлексией — имена классов нельзя обфусцировать
-keep class ru.atol.** { *; }
-keep class com.atol.** { *; }
-dontwarn ru.atol.**
-dontwarn com.atol.**

# Tink (androidx.security:security-crypto) ссылается на аннотации ErrorProne,
# которых нет в runtime-класспасе — для R8 это предупреждения, не ошибки.
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
