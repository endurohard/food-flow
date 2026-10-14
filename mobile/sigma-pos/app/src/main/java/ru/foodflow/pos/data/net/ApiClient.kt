package ru.foodflow.pos.data.net

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import ru.foodflow.pos.data.Settings
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Результат вызова API: либо тело, либо осмысленная ошибка. */
sealed class ApiResult<out T> {
    data class Ok<T>(val value: T) : ApiResult<T>()
    /** HTTP-ответ с ошибкой — повторять бессмысленно до изменения запроса. */
    data class HttpError(val code: Int, val message: String) : ApiResult<Nothing>()
    /** Сети нет / таймаут — запрос надо положить в очередь и повторить. */
    data class Offline(val cause: String) : ApiResult<Nothing>()
}

/**
 * Тонкий HTTP-клиент над Kong. Повторяет поведение web-кассы (AUTH.fetch):
 * Bearer-токен, авто-refresh при 401, idempotency-key на мутациях.
 */
class ApiClient(private val settings: Settings) {

    val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    private val http = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val jsonType = "application/json; charset=utf-8".toMediaType()

    fun get(path: String): ApiResult<String> = call("GET", path, null, null)

    fun post(path: String, body: String, idempotencyKey: String? = null): ApiResult<String> =
        call("POST", path, body, idempotencyKey)

    fun put(path: String, body: String): ApiResult<String> = call("PUT", path, body, null)

    private fun call(
        method: String,
        path: String,
        body: String?,
        idempotencyKey: String?,
        isRetry: Boolean = false
    ): ApiResult<String> {
        val base = settings.apiBase
        if (base.isBlank()) return ApiResult.HttpError(0, "Не задан адрес сервера")

        val req = Request.Builder()
            .url(if (path.startsWith("http")) path else base + path)
            .apply {
                when (method) {
                    "GET" -> get()
                    "POST" -> post((body ?: "{}").toRequestBody(jsonType))
                    "PUT" -> put((body ?: "{}").toRequestBody(jsonType))
                    else -> throw IllegalArgumentException(method)
                }
                settings.accessToken?.let { header("Authorization", "Bearer $it") }
                idempotencyKey?.let { header("idempotency-key", it) }
                header("Accept", "application/json")
            }
            .build()

        return try {
            http.newCall(req).execute().use { res ->
                val text = res.body?.string().orEmpty()
                when {
                    res.isSuccessful -> ApiResult.Ok(text)
                    // Токен истёк — обновляем и повторяем ровно один раз
                    res.code == 401 && !isRetry && refreshToken() ->
                        call(method, path, body, idempotencyKey, isRetry = true)
                    else -> ApiResult.HttpError(res.code, extractError(text, res.code))
                }
            }
        } catch (e: IOException) {
            ApiResult.Offline(e.message ?: "нет связи")
        }
    }

    /** Бэкенд отдаёт ошибку то в `error`, то в `message` — разбираем оба. */
    private fun extractError(text: String, code: Int): String {
        val obj = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull()
            ?: return "Ошибка сервера ($code)"
        val msg = obj["message"]?.jsonPrimitive?.contentOrNullSafe()
            ?: obj["error"]?.jsonPrimitive?.contentOrNullSafe()
        return msg ?: "Ошибка сервера ($code)"
    }

    private fun refreshToken(): Boolean {
        val refresh = settings.refreshToken ?: return false
        val req = Request.Builder()
            .url(settings.apiBase + "/api/auth/refresh")
            .post("""{"refreshToken":"$refresh"}""".toRequestBody(jsonType))
            .build()
        return try {
            http.newCall(req).execute().use { res ->
                if (!res.isSuccessful) return false
                val obj = json.parseToJsonElement(res.body?.string().orEmpty()).jsonObject
                val token = obj.findString("token", "accessToken") ?: return false
                settings.accessToken = token
                obj.findString("refreshToken")?.let { settings.refreshToken = it }
                true
            }
        } catch (e: IOException) {
            false
        }
    }
}

internal fun JsonObject.findString(vararg keys: String): String? {
    for (k in keys) {
        this[k]?.jsonPrimitive?.contentOrNullSafe()?.let { return it }
    }
    // Иногда полезная нагрузка лежит во вложенном data
    val data = this["data"]?.let { runCatching { it.jsonObject }.getOrNull() } ?: return null
    for (k in keys) {
        data[k]?.jsonPrimitive?.contentOrNullSafe()?.let { return it }
    }
    return null
}

internal fun kotlinx.serialization.json.JsonPrimitive.contentOrNullSafe(): String? =
    content.takeIf { it.isNotBlank() && it != "null" }
