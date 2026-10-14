package ru.foodflow.pos.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import ru.foodflow.pos.data.db.CategoryEntity
import ru.foodflow.pos.data.db.MenuItemEntity
import ru.foodflow.pos.data.db.ModifierEntity
import ru.foodflow.pos.data.db.PosDatabase
import ru.foodflow.pos.data.db.SaleEntity
import ru.foodflow.pos.data.net.ApiClient
import ru.foodflow.pos.data.net.ApiResult
import ru.foodflow.pos.fiscal.FiscalReceiptResult
import java.util.UUID

/** Результат входа. */
sealed class LoginResult {
    object Ok : LoginResult()
    data class Error(val message: String) : LoginResult()
}

/** Результат попытки загрузить меню. */
sealed class MenuSyncResult {
    data class Ok(val itemCount: Int) : MenuSyncResult()
    /** Нет сети — работаем на том, что уже в БД. */
    data class Offline(val cachedItems: Int) : MenuSyncResult()
    data class Error(val message: String) : MenuSyncResult()
}

class PosRepository(
    private val db: PosDatabase,
    private val api: ApiClient,
    val settings: Settings
) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    // ── наблюдаемые данные для UI ──────────────────────────────────────────
    fun observeCategories(): Flow<List<CategoryEntity>> = db.menuDao().observeCategories()
    fun observeItems(): Flow<List<MenuItemEntity>> = db.menuDao().observeItems()
    fun observeRecentSales(): Flow<List<SaleEntity>> = db.saleDao().observeRecent()
    fun observePendingSyncCount(): Flow<Int> = db.saleDao().observePendingCount()
    fun observeFiscalFailedCount(): Flow<Int> = db.saleDao().observeFiscalFailedCount()

    suspend fun modifiersFor(itemId: String): List<ModifierEntity> =
        withContext(Dispatchers.IO) { db.menuDao().modifiersFor(itemId) }

    // ── вход ───────────────────────────────────────────────────────────────

    suspend fun login(email: String, password: String): LoginResult = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("email", email.trim())
            put("password", password)
        }.toString()
        when (val res = api.post("/api/auth/login", body)) {
            is ApiResult.Offline -> LoginResult.Error("Нет связи с сервером — проверьте сеть и адрес")
            is ApiResult.HttpError -> LoginResult.Error(res.message)
            is ApiResult.Ok -> {
                val root = runCatching { json.parseToJsonElement(res.value) as JsonObject }
                    .getOrNull() ?: return@withContext LoginResult.Error("Непонятный ответ сервера")
                val token = findDeep(root, "token", "accessToken")
                    ?: return@withContext LoginResult.Error("Сервер не вернул токен")
                settings.accessToken = token
                findDeep(root, "refreshToken")?.let { settings.refreshToken = it }
                val user = (root["user"] as? JsonObject)
                    ?: ((root["data"] as? JsonObject)?.get("user") as? JsonObject)
                if (user != null) {
                    settings.userId = ApiParser.str(user, "userId", "id")
                    settings.userName = ApiParser.str(user, "first_name", "firstName", "email")
                    settings.enterpriseRole =
                        ApiParser.str(user, "enterpriseRole", "enterprise_role", "role")
                }
                LoginResult.Ok
            }
        }
    }

    fun logout() {
        settings.clearSession()
    }

    // ── меню ───────────────────────────────────────────────────────────────

    /**
     * Полная выгрузка меню в локальную БД. Без сети возвращает Offline —
     * касса продолжает работать на кэше.
     */
    suspend fun syncMenu(): MenuSyncResult = withContext(Dispatchers.IO) {
        val cached = db.menuDao().itemCount()

        // Заведение: веб-касса берёт restaurants[0], повторяем и запоминаем
        if (settings.restaurantId == null) {
            when (val res = api.get("/api/restaurants")) {
                is ApiResult.Offline -> return@withContext MenuSyncResult.Offline(cached)
                is ApiResult.HttpError -> return@withContext MenuSyncResult.Error(res.message)
                is ApiResult.Ok -> {
                    val first = ApiParser.array(json, res.value, "restaurants").firstOrNull()
                            as? JsonObject
                        ?: return@withContext MenuSyncResult.Error(
                            "У предприятия нет заведения — создайте его в админке"
                        )
                    settings.restaurantId = ApiParser.str(first, "id")
                    settings.restaurantName = ApiParser.str(first, "name")
                }
            }
        }
        val restaurantId = settings.restaurantId
            ?: return@withContext MenuSyncResult.Error("Заведение не определено")

        val catsRes = api.get("/api/restaurants/$restaurantId/menu-categories")
        val itemsRes = api.get("/api/restaurants/$restaurantId/menu-items")
        if (catsRes is ApiResult.Offline || itemsRes is ApiResult.Offline) {
            return@withContext MenuSyncResult.Offline(cached)
        }
        if (itemsRes is ApiResult.HttpError) {
            return@withContext MenuSyncResult.Error(itemsRes.message)
        }

        val categories = (catsRes as? ApiResult.Ok)
            ?.let { ApiParser.categories(json, it.value) } ?: emptyList()
        val items = ApiParser.menuItems(json, (itemsRes as ApiResult.Ok).value, settings.vatRate)

        // Модификаторы тянем только для доступных позиций — запросов и так много
        val modifiers = mutableListOf<ModifierEntity>()
        items.filter { !it.isStopped() }.forEach { item ->
            when (val r = api.get("/api/restaurants/menu-items/${item.id}/modifiers")) {
                is ApiResult.Ok -> modifiers += ApiParser.modifiers(json, r.value, item.id)
                is ApiResult.Offline -> return@forEach
                is ApiResult.HttpError -> return@forEach
            }
        }

        db.menuDao().replaceMenu(categories, items, modifiers)
        settings.menuSyncedAt = System.currentTimeMillis()
        MenuSyncResult.Ok(items.size)
    }

    /** Поиск открытой кассы — нужна, чтобы наличные попадали в cash_operations. */
    suspend fun refreshOpenRegister(): String? = withContext(Dispatchers.IO) {
        when (val res = api.get("/api/finance/registers?status=open")) {
            is ApiResult.Ok -> {
                val open = ApiParser.array(json, res.value, "registers")
                    .filterIsInstance<JsonObject>()
                    .firstOrNull { ApiParser.str(it, "status") == "open" }
                settings.registerId = open?.let { ApiParser.str(it, "id") }
                settings.registerId
            }
            // Кассиру список касс может быть недоступен (403) — не критично
            else -> settings.registerId
        }
    }

    // ── продажи ────────────────────────────────────────────────────────────

    /**
     * Записывает продажу локально. Вызывается ДО попытки сетевой отправки:
     * чек уже пробит на ФР, продажа не должна потеряться ни при каких сбоях.
     */
    suspend fun recordSale(
        cart: Cart,
        paymentMethod: String,
        orderType: String,
        cashGotKopecks: Long?
    ): SaleEntity = withContext(Dispatchers.IO) {
        val sale = SaleEntity(
            id = UUID.randomUUID().toString(),
            restaurantId = settings.restaurantId.orEmpty(),
            registerId = settings.registerId,
            orderType = orderType,
            paymentMethod = paymentMethod,
            totalKopecks = cart.totalKopecks,
            cashGotKopecks = cashGotKopecks,
            linesJson = encodeLines(cart.lines),
            createdAt = System.currentTimeMillis(),
            fiscalStatus = if (settings.fiscalEnabled) "pending" else "disabled",
            paymentIdempotencyKey = UUID.randomUUID().toString()
        )
        db.saleDao().insert(sale)
        sale
    }

    suspend fun saleById(id: String): SaleEntity? =
        withContext(Dispatchers.IO) { db.saleDao().byId(id) }

    suspend fun markFiscalPrinted(saleId: String, result: FiscalReceiptResult) =
        withContext(Dispatchers.IO) {
            db.saleDao().updateFiscal(
                id = saleId,
                status = "printed",
                receiptNumber = result.receiptNumber,
                documentNumber = result.fiscalDocumentNumber,
                fiscalSign = result.fiscalSign,
                shiftNumber = result.shiftNumber,
                ofdUrl = result.ofdUrl,
                error = null
            )
        }

    suspend fun markFiscalFailed(saleId: String, error: String) = withContext(Dispatchers.IO) {
        db.saleDao().updateFiscal(
            id = saleId, status = "failed", receiptNumber = null, documentNumber = null,
            fiscalSign = null, shiftNumber = null, ofdUrl = null, error = error
        )
    }

    suspend fun markSync(
        id: String,
        status: String,
        orderId: String?,
        orderNumber: String?,
        paymentSynced: Boolean,
        cashSynced: Boolean,
        fiscalSynced: Boolean,
        error: String?,
        syncedAt: Long?
    ) = withContext(Dispatchers.IO) {
        db.saleDao().updateSync(
            id, status, orderId, orderNumber,
            paymentSynced, cashSynced, fiscalSynced, error, syncedAt
        )
    }

    suspend fun pendingSales(limit: Int = 50): List<SaleEntity> =
        withContext(Dispatchers.IO) { db.saleDao().pendingSync(limit) }

    /** Итоги за период из локальных данных — работают и без сети. */
    suspend fun localTotals(since: Long): Triple<Long, Long, Int> = withContext(Dispatchers.IO) {
        val cash = db.saleDao().totalSince("cash", since)
        val card = db.saleDao().totalSince("card", since)
        val count = db.saleDao().countSince(since)
        Triple(cash, card, count)
    }

    // ── сериализация строк чека ────────────────────────────────────────────

    fun encodeLines(lines: List<CartLine>): String =
        json.encodeToString(ListSerializer(CartLine.serializer()), lines)

    fun decodeLines(text: String): List<CartLine> =
        runCatching {
            json.decodeFromString(ListSerializer(CartLine.serializer()), text)
        }.getOrElse { emptyList() }

    private fun findDeep(root: JsonObject, vararg keys: String): String? {
        ApiParser.str(root, *keys)?.let { return it }
        (root["data"] as? JsonObject)?.let { ApiParser.str(it, *keys)?.let { v -> return v } }
        (root["tokens"] as? JsonObject)?.let { ApiParser.str(it, *keys)?.let { v -> return v } }
        return null
    }
}
