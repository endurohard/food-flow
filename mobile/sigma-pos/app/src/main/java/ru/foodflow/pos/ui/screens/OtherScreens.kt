package ru.foodflow.pos.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Divider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import ru.foodflow.pos.data.Money
import ru.foodflow.pos.data.db.SaleEntity
import ru.foodflow.pos.fiscal.TaxationType
import ru.foodflow.pos.fiscal.VatRate
import ru.foodflow.pos.ui.PosViewModel
import ru.foodflow.pos.ui.SaleOutcome
import ru.foodflow.pos.ui.Screen
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Итог продажи: что с чеком и дошло ли до сервера. */
@Composable
fun SaleDoneDialog(outcome: SaleOutcome, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                if (outcome.orderNumber != null) "Заказ №${outcome.orderNumber} оплачен"
                else "Продажа оформлена"
            )
        },
        text = {
            Column {
                Text(
                    Money.format(outcome.totalKopecks),
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold
                )
                if (outcome.changeKopecks > 0) {
                    Spacer(Modifier.height(4.dp))
                    Text("Сдача: " + Money.format(outcome.changeKopecks))
                }
                Spacer(Modifier.height(12.dp))
                // Честно показываем кассиру, что именно получилось,
                // а что осталось в очереди — иначе он не узнает о проблеме.
                Text(
                    when {
                        outcome.fiscalPrinted -> "✓ Фискальный чек напечатан"
                        outcome.fiscalError != null -> "✗ Чек НЕ пробит: ${outcome.fiscalError}"
                        else -> "Фискализация выключена в настройках"
                    },
                    color = if (outcome.fiscalError != null) MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.onSurface
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    if (outcome.syncedOnline) "✓ Отправлено на сервер"
                    else "⏳ Нет связи — отправится автоматически",
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        },
        confirmButton = {
            Button(onClick = onDismiss) { Text("Новый чек") }
        }
    )
}

/** Журнал продаж: видно, что не пробито и что не отправлено. */
@Composable
fun JournalScreen(vm: PosViewModel, padding: PaddingValues) {
    val sales by vm.recentSales.collectAsState()
    val pending by vm.pendingSyncCount.collectAsState()

    Column(Modifier.fillMaxSize().padding(padding).padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Журнал продаж",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f)
            )
            if (pending > 0) {
                TextButton(onClick = { vm.forceSync() }) { Text("Отправить ($pending)") }
            }
            TextButton(onClick = { vm.navigate(Screen.POS) }) { Text("К кассе") }
        }
        Spacer(Modifier.height(8.dp))

        if (sales.isEmpty()) {
            Text(
                "Продаж пока нет",
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                items(sales, key = { it.id }) { sale ->
                    SaleRow(sale, vm)
                }
            }
        }
    }
}

private val timeFmt = SimpleDateFormat("dd.MM HH:mm", Locale("ru"))

@Composable
private fun SaleRow(sale: SaleEntity, vm: PosViewModel) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = if (sale.fiscalStatus == "failed")
                MaterialTheme.colorScheme.errorContainer
            else MaterialTheme.colorScheme.surface
        )
    ) {
        Column(Modifier.padding(12.dp).fillMaxWidth()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        timeFmt.format(Date(sale.createdAt)) + " · " +
                            (if (sale.paymentMethod == "cash") "наличные" else "карта"),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    sale.serverOrderNumber?.let {
                        Text("Заказ №$it", style = MaterialTheme.typography.bodySmall)
                    }
                }
                Text(
                    Money.format(sale.totalKopecks),
                    fontWeight = FontWeight.Bold,
                    style = MaterialTheme.typography.titleMedium
                )
            }
            Spacer(Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    when (sale.fiscalStatus) {
                        "printed" -> "чек: напечатан"
                        "failed" -> "чек: ОШИБКА"
                        "disabled" -> "чек: без фискализации"
                        else -> "чек: ожидает"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = if (sale.fiscalStatus == "failed") MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    when (sale.syncStatus) {
                        "synced" -> "сервер: отправлено"
                        "failed" -> "сервер: отклонено"
                        else -> "сервер: в очереди"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            sale.fiscalError?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error
                )
            }
            sale.lastSyncError?.takeIf { sale.syncStatus != "synced" }?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            if (sale.fiscalStatus == "failed") {
                Spacer(Modifier.height(6.dp))
                OutlinedButton(onClick = { vm.retryFiscal(sale.id) }) {
                    Text("Пробить чек повторно")
                }
            }
        }
    }
}

/** Управление сменой ФР: открытие, X-отчёт, закрытие (Z-отчёт). */
@Composable
fun ShiftScreen(vm: PosViewModel, padding: PaddingValues) {
    val shift by vm.shiftState.collectAsState()
    val busy by vm.busy.collectAsState()
    val driverOk by vm.fiscalDriverAvailable.collectAsState()
    var confirmClose by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxSize().padding(padding).padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Смена",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f)
            )
            TextButton(onClick = { vm.navigate(Screen.POS) }) { Text("К кассе") }
        }
        Spacer(Modifier.height(12.dp))

        Text(
            when {
                driverOk == false -> "Фискальный регистратор недоступен"
                shift == null -> "Состояние смены неизвестно"
                shift!!.isExpired -> "Смена открыта более 24 часов — ККТ откажет в чеке"
                shift!!.isOpen -> "Смена открыта" +
                    (shift!!.shiftNumber?.let { " №$it" } ?: "")
                else -> "Смена закрыта"
            },
            color = if (shift?.isExpired == true || driverOk == false)
                MaterialTheme.colorScheme.error
            else MaterialTheme.colorScheme.onSurface,
            fontWeight = FontWeight.SemiBold
        )

        Spacer(Modifier.height(20.dp))
        Button(
            onClick = { vm.openShift() },
            enabled = !busy && shift?.isOpen != true,
            modifier = Modifier.fillMaxWidth().height(52.dp)
        ) { Text("Открыть смену") }

        Spacer(Modifier.height(10.dp))
        OutlinedButton(
            onClick = { vm.printXReport() },
            enabled = !busy,
            modifier = Modifier.fillMaxWidth().height(52.dp)
        ) { Text("X-отчёт (без закрытия)") }

        Spacer(Modifier.height(10.dp))
        OutlinedButton(
            onClick = { confirmClose = true },
            enabled = !busy && shift?.isOpen == true,
            modifier = Modifier.fillMaxWidth().height(52.dp)
        ) { Text("Закрыть смену (Z-отчёт)") }

        Spacer(Modifier.height(10.dp))
        TextButton(onClick = { vm.refreshShift() }) { Text("Обновить состояние") }
    }

    if (confirmClose) {
        AlertDialog(
            onDismissRequest = { confirmClose = false },
            title = { Text("Закрыть смену?") },
            text = {
                Text(
                    "Будет напечатан Z-отчёт. Операция необратима — " +
                        "продажи после неё пойдут в новую смену."
                )
            },
            confirmButton = {
                Button(onClick = {
                    confirmClose = false
                    vm.closeShift()
                }) { Text("Закрыть смену") }
            },
            dismissButton = {
                TextButton(onClick = { confirmClose = false }) { Text("Отмена") }
            }
        )
    }
}

/** Настройки: фискализация, СНО, НДС, сервер, выход. */
@Composable
fun SettingsScreen(vm: PosViewModel, padding: PaddingValues) {
    val driverOk by vm.fiscalDriverAvailable.collectAsState()
    var fiscal by remember { mutableStateOf(vm.settings.fiscalEnabled) }
    var taxation by remember { mutableStateOf(vm.settings.taxationType) }
    var vat by remember { mutableStateOf(vm.settings.vatRate) }

    Column(Modifier.fillMaxSize().padding(padding).padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Настройки",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f)
            )
            TextButton(onClick = { vm.navigate(Screen.POS) }) { Text("К кассе") }
        }
        Spacer(Modifier.height(12.dp))

        Text("Сервер: ${vm.settings.apiBase}", style = MaterialTheme.typography.bodyMedium)
        Text(
            "Заведение: ${vm.settings.restaurantName ?: "не выбрано"}",
            style = MaterialTheme.typography.bodyMedium
        )
        Text(
            "Кассир: ${vm.settings.userName ?: "—"} (${vm.settings.enterpriseRole ?: "—"})",
            style = MaterialTheme.typography.bodyMedium
        )
        Text(
            "Драйвер ККТ: " + when (driverOk) {
                true -> "доступен"
                false -> "НЕ доступен"
                null -> "проверка…"
            },
            style = MaterialTheme.typography.bodyMedium,
            color = if (driverOk == false) MaterialTheme.colorScheme.error
            else MaterialTheme.colorScheme.onSurface
        )

        Divider(Modifier.padding(vertical = 12.dp))

        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Печатать фискальный чек")
                Text(
                    "Выключайте только для отладки — продажи будут без фискализации",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Switch(
                checked = fiscal,
                onCheckedChange = {
                    fiscal = it
                    vm.setFiscalEnabled(it)
                }
            )
        }

        Spacer(Modifier.height(16.dp))
        Text("Система налогообложения", style = MaterialTheme.typography.labelLarge)
        Spacer(Modifier.height(6.dp))
        Column {
            TaxationType.entries.forEach { t ->
                TextButton(onClick = {
                    taxation = t.code
                    vm.setTaxation(t.code)
                }) {
                    Text((if (taxation == t.code) "● " else "○ ") + t.title)
                }
            }
        }

        Spacer(Modifier.height(16.dp))
        Text("Ставка НДС по умолчанию", style = MaterialTheme.typography.labelLarge)
        Spacer(Modifier.height(6.dp))
        Column {
            VatRate.entries.forEach { v ->
                TextButton(onClick = {
                    vat = v.code
                    vm.setVatRate(v.code)
                }) {
                    Text((if (vat == v.code) "● " else "○ ") + v.title)
                }
            }
        }

        Divider(Modifier.padding(vertical = 12.dp))
        OutlinedButton(
            onClick = { vm.navigate(Screen.SETUP) },
            modifier = Modifier.fillMaxWidth()
        ) { Text("Изменить адрес сервера") }
        Spacer(Modifier.height(8.dp))
        OutlinedButton(
            onClick = { vm.logout() },
            modifier = Modifier.fillMaxWidth()
        ) { Text("Выйти из аккаунта") }
    }
}
