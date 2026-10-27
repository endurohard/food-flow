package ru.foodflow.pos.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Настройки терминала и токены. Хранится в EncryptedSharedPreferences —
 * JWT и пароль кассира не должны лежать в открытом виде на устройстве,
 * к которому физически имеет доступ персонал.
 */
class Settings(context: Context) {

    private val prefs: SharedPreferences = runCatching {
        val key = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "ff_pos_secure",
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        ) as SharedPreferences
    }.getOrElse {
        // На части прошивок Sigma отсутствует рабочий keystore —
        // падать нельзя, иначе касса не запустится вообще.
        context.getSharedPreferences("ff_pos_plain", Context.MODE_PRIVATE)
    }

    var apiBase: String
        get() = prefs.getString(KEY_API_BASE, "").orEmpty()
        set(v) = prefs.edit().putString(KEY_API_BASE, v.trimEnd('/')).apply()

    var accessToken: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(v) = prefs.edit().putString(KEY_TOKEN, v).apply()

    var refreshToken: String?
        get() = prefs.getString(KEY_REFRESH, null)
        set(v) = prefs.edit().putString(KEY_REFRESH, v).apply()

    var userId: String?
        get() = prefs.getString(KEY_USER_ID, null)
        set(v) = prefs.edit().putString(KEY_USER_ID, v).apply()

    var userName: String?
        get() = prefs.getString(KEY_USER_NAME, null)
        set(v) = prefs.edit().putString(KEY_USER_NAME, v).apply()

    var enterpriseRole: String?
        get() = prefs.getString(KEY_ROLE, null)
        set(v) = prefs.edit().putString(KEY_ROLE, v).apply()

    /** Выбранное заведение (restaurants[0] в веб-кассе). */
    var restaurantId: String?
        get() = prefs.getString(KEY_RESTAURANT, null)
        set(v) = prefs.edit().putString(KEY_RESTAURANT, v).apply()

    /**
     * Имя организации из кода привязки. Нужно только для показа на экране
     * входа: кассир видит, к какой организации привязан терминал, до логина.
     */
    var enterpriseName: String?
        get() = prefs.getString(KEY_ENTERPRISE_NAME, null)
        set(v) = prefs.edit().putString(KEY_ENTERPRISE_NAME, v).apply()

    var restaurantName: String?
        get() = prefs.getString(KEY_RESTAURANT_NAME, null)
        set(v) = prefs.edit().putString(KEY_RESTAURANT_NAME, v).apply()

    /** Открытая касса (cash_registers.id) для проведения наличных. */
    var registerId: String?
        get() = prefs.getString(KEY_REGISTER, null)
        set(v) = prefs.edit().putString(KEY_REGISTER, v).apply()

    /** Система налогообложения для фискального чека (код задания ККТ). */
    var taxationType: String
        get() = prefs.getString(KEY_TAXATION, "usnIncome").orEmpty()
        set(v) = prefs.edit().putString(KEY_TAXATION, v).apply()

    /** Ставка НДС по умолчанию для позиций чека. */
    var vatRate: String
        get() = prefs.getString(KEY_VAT, "none").orEmpty()
        set(v) = prefs.edit().putString(KEY_VAT, v).apply()

    /** Печатать ли фискальный чек; при выключении работает как нефискальный POS. */
    var fiscalEnabled: Boolean
        get() = prefs.getBoolean(KEY_FISCAL, true)
        set(v) = prefs.edit().putBoolean(KEY_FISCAL, v).apply()

    /** Время последней успешной синхронизации меню, мс. */
    var menuSyncedAt: Long
        get() = prefs.getLong(KEY_MENU_SYNCED, 0L)
        set(v) = prefs.edit().putLong(KEY_MENU_SYNCED, v).apply()

    val isLoggedIn: Boolean get() = !accessToken.isNullOrBlank()
    val isConfigured: Boolean get() = apiBase.isNotBlank()

    fun clearSession() {
        prefs.edit()
            .remove(KEY_TOKEN).remove(KEY_REFRESH)
            .remove(KEY_USER_ID).remove(KEY_USER_NAME).remove(KEY_ROLE)
            .remove(KEY_REGISTER)
            .apply()
    }

    private companion object {
        const val KEY_API_BASE = "api_base"
        const val KEY_TOKEN = "token"
        const val KEY_REFRESH = "refresh_token"
        const val KEY_USER_ID = "user_id"
        const val KEY_USER_NAME = "user_name"
        const val KEY_ROLE = "enterprise_role"
        const val KEY_RESTAURANT = "restaurant_id"
        const val KEY_ENTERPRISE_NAME = "enterprise_name"
        const val KEY_RESTAURANT_NAME = "restaurant_name"
        const val KEY_REGISTER = "register_id"
        const val KEY_TAXATION = "taxation_type"
        const val KEY_VAT = "vat_rate"
        const val KEY_FISCAL = "fiscal_enabled"
        const val KEY_MENU_SYNCED = "menu_synced_at"
    }
}
