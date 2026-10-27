package ru.foodflow.pos.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import ru.foodflow.pos.PosApplication
import ru.foodflow.pos.BuildConfig
import ru.foodflow.pos.data.Binding
import ru.foodflow.pos.data.Cart
import ru.foodflow.pos.data.CartLine
import ru.foodflow.pos.data.CartModifier
import ru.foodflow.pos.data.LoginResult
import ru.foodflow.pos.data.MenuSyncResult
import ru.foodflow.pos.data.SaleSyncer
import ru.foodflow.pos.data.db.CategoryEntity
import ru.foodflow.pos.data.db.MenuItemEntity
import ru.foodflow.pos.data.db.ModifierEntity
import ru.foodflow.pos.data.db.SaleEntity
import ru.foodflow.pos.fiscal.FiscalException
import ru.foodflow.pos.fiscal.FiscalItem
import ru.foodflow.pos.fiscal.FiscalReceiptRequest
import ru.foodflow.pos.fiscal.PaymentType
import ru.foodflow.pos.fiscal.ShiftState
import ru.foodflow.pos.fiscal.TaxationType
import ru.foodflow.pos.fiscal.VatRate
import ru.foodflow.pos.sync.SyncWorker

/** Экран, на котором находится касса. */
enum class Screen { SETUP, LOGIN, POS, JOURNAL, SHIFT, SETTINGS }

/** Итог продажи для экрана «оплачено». */
data class SaleOutcome(
    val saleId: String,
    val orderNumber: String?,
    val totalKopecks: Long,
    val changeKopecks: Long,
    val paymentMethod: String,
    val fiscalPrinted: Boolean,
    val fiscalError: String?,
    val syncedOnline: Boolean
)

class PosViewModel(app: Application) : AndroidViewModel(app) {

    private val application = app as PosApplication
    private val repo = application.repository
    val settings = application.settings

    // ── состояние экрана ───────────────────────────────────────────────────
    private val _screen = MutableStateFlow(
        when {
            !settings.isConfigured -> Screen.SETUP
            !settings.isLoggedIn -> Screen.LOGIN
            else -> Screen.POS
        }
    )
    val screen: StateFlow<Screen> = _screen.asStateFlow()

    private val _cart = MutableStateFlow(Cart())
    val cart: StateFlow<Cart> = _cart.asStateFlow()

    private val _category = MutableStateFlow<String?>(null)
    val category: StateFlow<String?> = _category.asStateFlow()

    private val _search = MutableStateFlow("")
    val search: StateFlow<String> = _search.asStateFlow()

    private val _orderType = MutableStateFlow("pickup")
    val orderType: StateFlow<String> = _orderType.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private val _toast = MutableStateFlow<String?>(null)
    val toast: StateFlow<String?> = _toast.asStateFlow()

    private val _statusLine = MutableStateFlow("")
    val statusLine: StateFlow<String> = _statusLine.asStateFlow()

    private val _lastSale = MutableStateFlow<SaleOutcome?>(null)
    val lastSale: StateFlow<SaleOutcome?> = _lastSale.asStateFlow()

    private val _shiftState = MutableStateFlow<ShiftState?>(null)
    val shiftState: StateFlow<ShiftState?> = _shiftState.asStateFlow()

    private val _fiscalDriverAvailable = MutableStateFlow<Boolean?>(null)
    val fiscalDriverAvailable: StateFlow<Boolean?> = _fiscalDriverAvailable.asStateFlow()

    val categories: StateFlow<List<CategoryEntity>> = repo.observeCategories()
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    val items: StateFlow<List<MenuItemEntity>> = repo.observeItems()
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    val recentSales: StateFlow<List<SaleEntity>> = repo.observeRecentSales()
        .stateIn(viewModelScope, SharingStarted.Lazily, emptyList())

    val pendingSyncCount: StateFlow<Int> = repo.observePendingSyncCount()
        .stateIn(viewModelScope, SharingStarted.Eagerly, 0)

    val fiscalFailedCount: StateFlow<Int> = repo.observeFiscalFailedCount()
        .stateIn(viewModelScope, SharingStarted.Eagerly, 0)

    init {
        if (settings.isLoggedIn) bootstrap()
    }

    // ── настройка и вход ───────────────────────────────────────────────────

    fun saveServerUrl(url: String) {
        val normalized = url.trim().let {
            if (it.startsWith("http://") || it.startsWith("https://")) it else "https://$it"
        }
        settings.apiBase = normalized
        _screen.value = if (settings.isLoggedIn) Screen.POS else Screen.LOGIN
    }

    /**
     * Привязка терминала к организации: на вход — содержимое QR, короткий код
     * организации или полный адрес. Неразобранный код нельзя молча принять:
     * касса ушла бы работать не на тот сервер, поэтому ошибка видна на экране.
     */
    fun applyBinding(raw: String) {
        val target = Binding.parse(raw, BuildConfig.PLATFORM_DOMAIN)
        if (target == null) {
            _toast.value = "Не удалось разобрать код привязки — отсканируйте QR заново"
            return
        }
        settings.apiBase = target.apiBase
        settings.enterpriseName = target.orgName
        _toast.value = target.orgName?.let { "Организация: $it" } ?: "Сервер: ${target.apiBase}"
        _screen.value = if (settings.isLoggedIn) Screen.POS else Screen.LOGIN
    }

    fun login(email: String, password: String) = launchBusy {
        when (val res = repo.login(email, password)) {
            is LoginResult.Ok -> {
                _screen.value = Screen.POS
                bootstrap()
            }
            is LoginResult.Error -> _toast.value = res.message
        }
    }

    fun logout() {
        repo.logout()
        _cart.value = Cart()
        _screen.value = Screen.LOGIN
    }

    /** Подтягивает меню, кассу и состояние ФР при запуске. */
    private fun bootstrap() = viewModelScope.launch {
        checkFiscalDriver()
        refreshShift()
        syncMenu(silent = true)
        repo.refreshOpenRegister()
        updateStatus()
    }

    fun syncMenu(silent: Boolean = false) = launchBusy {
        when (val res = repo.syncMenu()) {
            is MenuSyncResult.Ok -> {
                if (!silent) _toast.value = "Меню обновлено: ${res.itemCount} позиций"
            }
            is MenuSyncResult.Offline -> {
                if (!silent) _toast.value =
                    "Нет связи — работаем на локальном меню (${res.cachedItems} позиций)"
            }
            is MenuSyncResult.Error -> _toast.value = res.message
        }
        updateStatus()
    }

    private suspend fun updateStatus() {
        val name = settings.restaurantName.orEmpty()
        val pending = pendingSyncCount.value
        val shift = _shiftState.value
        _statusLine.value = buildString {
            if (name.isNotBlank()) append(name).append(" · ")
            append(
                when {
                    shift == null -> "ФР: нет связи"
                    shift.isExpired -> "смена >24ч — закройте"
                    shift.isOpen -> "смена открыта"
                    else -> "смена закрыта"
                }
            )
            if (pending > 0) append(" · не отправлено: ").append(pending)
        }
    }

    // ── фискальный регистратор ─────────────────────────────────────────────

    fun checkFiscalDriver() = viewModelScope.launch {
        _fiscalDriverAvailable.value = runCatching {
            application.activeFiscalDriver().isAvailable()
        }.getOrDefault(false)
    }

    fun refreshShift() = viewModelScope.launch {
        _shiftState.value = runCatching { application.activeFiscalDriver().shiftState() }
            .getOrNull()
        updateStatus()
    }

    fun openShift() = launchBusy {
        runCatching { application.activeFiscalDriver().openShift() }
            .onSuccess {
                _shiftState.value = it
                _toast.value = "Смена открыта" + (it.shiftNumber?.let { n -> " №$n" } ?: "")
            }
            .onFailure { _toast.value = it.message ?: "Не удалось открыть смену" }
        updateStatus()
    }

    fun closeShift() = launchBusy {
        runCatching { application.activeFiscalDriver().closeShift() }
            .onSuccess {
                _toast.value = "Смена закрыта, Z-отчёт напечатан"
                _shiftState.value = runCatching {
                    application.activeFiscalDriver().shiftState()
                }.getOrNull()
            }
            .onFailure { _toast.value = it.message ?: "Не удалось закрыть смену" }
        updateStatus()
    }

    fun printXReport() = launchBusy {
        runCatching { application.activeFiscalDriver().printXReport() }
            .onSuccess { _toast.value = "X-отчёт напечатан" }
            .onFailure { _toast.value = it.message ?: "Не удалось напечатать X-отчёт" }
    }

    // ── корзина ────────────────────────────────────────────────────────────

    fun selectCategory(id: String?) { _category.value = id }
    fun setSearch(text: String) { _search.value = text }
    fun setOrderType(type: String) { _orderType.value = type }

    suspend fun modifiersFor(itemId: String): List<ModifierEntity> = repo.modifiersFor(itemId)

    fun addToCart(item: MenuItemEntity, modifiers: List<ModifierEntity> = emptyList()) {
        if (item.isStopped()) {
            _toast.value = "«${item.name}» в стоп-листе"
            return
        }
        _cart.value = _cart.value.add(
            CartLine(
                menuItemId = item.id,
                name = item.name,
                unitPriceKopecks = item.priceKopecks,
                quantity = 1,
                vatRate = item.vatRate ?: settings.vatRate,
                modifiers = modifiers.map {
                    CartModifier(it.id, it.name, it.priceAdjustmentKopecks)
                }
            )
        )
    }

    fun changeQuantity(mergeKey: String, delta: Int) {
        _cart.value = _cart.value.changeQuantity(mergeKey, delta)
    }

    fun removeLine(mergeKey: String) { _cart.value = _cart.value.remove(mergeKey) }
    fun clearCart() { _cart.value = Cart() }

    // ── оплата ─────────────────────────────────────────────────────────────

    /**
     * Главный сценарий. Порядок операций выбран так, чтобы ни одна продажа
     * не потерялась и ни один чек не продублировался:
     *   1) запись продажи в локальную БД (источник истины);
     *   2) печать фискального чека на ФР;
     *   3) попытка отправки на сервер — при неудаче остаётся в очереди.
     */
    fun pay(method: String, cashGotKopecks: Long? = null) = launchBusy {
        val currentCart = _cart.value
        if (currentCart.isEmpty) return@launchBusy
        if (settings.restaurantId == null) {
            _toast.value = "Заведение не определено — обновите меню"
            return@launchBusy
        }

        val sale = repo.recordSale(
            cart = currentCart,
            paymentMethod = method,
            orderType = _orderType.value,
            cashGotKopecks = cashGotKopecks
        )

        // ── 2. Фискальный чек ───────────────────────────────────────────
        var fiscalPrinted = false
        var fiscalError: String? = null
        if (settings.fiscalEnabled) {
            val request = FiscalReceiptRequest(
                saleId = sale.id,
                items = currentCart.lines.map { line ->
                    FiscalItem(
                        name = line.name,
                        priceKopecks = line.effectiveUnitPriceKopecks,
                        quantity = line.quantity.toDouble(),
                        vat = VatRate.from(line.vatRate)
                    )
                },
                paymentType = if (method == "cash") PaymentType.CASH else PaymentType.ELECTRONIC,
                paidKopecks = cashGotKopecks ?: currentCart.totalKopecks,
                taxation = TaxationType.from(settings.taxationType),
                cashierName = settings.userName,
                placeName = settings.restaurantName
            )
            try {
                val result = application.activeFiscalDriver().printReceipt(request)
                repo.markFiscalPrinted(sale.id, result)
                fiscalPrinted = true
            } catch (e: FiscalException) {
                fiscalError = e.message
                repo.markFiscalFailed(sale.id, e.message ?: "Ошибка ФР")
            } catch (e: Exception) {
                fiscalError = e.message ?: "Ошибка ФР"
                repo.markFiscalFailed(sale.id, fiscalError)
            }
        }

        // ── 3. Отправка на сервер ───────────────────────────────────────
        val syncer = SaleSyncer(application.api, repo)
        val fresh = repo.saleById(sale.id) ?: sale
        val syncOutcome = runCatching { syncer.sync(fresh) }.getOrNull()
        val syncedOnline = syncOutcome is SaleSyncer.Outcome.Synced
        if (!syncedOnline) SyncWorker.syncNow(application)

        _lastSale.value = SaleOutcome(
            saleId = sale.id,
            orderNumber = (syncOutcome as? SaleSyncer.Outcome.Synced)
                ?.let { repo.saleById(sale.id)?.serverOrderNumber },
            totalKopecks = currentCart.totalKopecks,
            changeKopecks = ((cashGotKopecks ?: 0L) - currentCart.totalKopecks).coerceAtLeast(0L),
            paymentMethod = method,
            fiscalPrinted = fiscalPrinted,
            fiscalError = fiscalError,
            syncedOnline = syncedOnline
        )
        _cart.value = Cart()
        updateStatus()
    }

    fun dismissSaleOutcome() { _lastSale.value = null }

    /** Повторная печать чека, который не удалось пробить. */
    fun retryFiscal(saleId: String) = launchBusy {
        val sale = repo.saleById(saleId) ?: return@launchBusy
        val lines = repo.decodeLines(sale.linesJson)
        if (lines.isEmpty()) {
            _toast.value = "Не удалось восстановить позиции чека"
            return@launchBusy
        }
        val request = FiscalReceiptRequest(
            saleId = sale.id,
            items = lines.map {
                FiscalItem(
                    name = it.name,
                    priceKopecks = it.effectiveUnitPriceKopecks,
                    quantity = it.quantity.toDouble(),
                    vat = VatRate.from(it.vatRate)
                )
            },
            paymentType = if (sale.paymentMethod == "cash") PaymentType.CASH
            else PaymentType.ELECTRONIC,
            paidKopecks = sale.cashGotKopecks ?: sale.totalKopecks,
            taxation = TaxationType.from(settings.taxationType),
            cashierName = settings.userName,
            placeName = settings.restaurantName
        )
        runCatching { application.activeFiscalDriver().printReceipt(request) }
            .onSuccess {
                repo.markFiscalPrinted(sale.id, it)
                _toast.value = "Чек напечатан"
                SyncWorker.syncNow(application)
            }
            .onFailure { _toast.value = it.message ?: "Снова не удалось напечатать" }
    }

    fun forceSync() {
        SyncWorker.syncNow(application)
        _toast.value = "Отправка очереди запущена"
    }

    // ── настройки ──────────────────────────────────────────────────────────

    fun setFiscalEnabled(enabled: Boolean) {
        settings.fiscalEnabled = enabled
        checkFiscalDriver()
        refreshShift()
    }

    fun setTaxation(code: String) { settings.taxationType = code }
    fun setVatRate(code: String) { settings.vatRate = code }

    fun navigate(screen: Screen) { _screen.value = screen }
    fun consumeToast() { _toast.value = null }

    private fun launchBusy(block: suspend () -> Unit) = viewModelScope.launch {
        if (_busy.value) return@launch
        _busy.value = true
        try {
            block()
        } finally {
            _busy.value = false
        }
    }
}
