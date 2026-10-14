package ru.foodflow.pos.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Divider
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ru.foodflow.pos.data.CartLine
import ru.foodflow.pos.data.Money
import ru.foodflow.pos.data.db.MenuItemEntity
import ru.foodflow.pos.data.db.ModifierEntity
import ru.foodflow.pos.ui.PosViewModel
import ru.foodflow.pos.ui.Screen

@Composable
fun PosScreen(vm: PosViewModel, padding: PaddingValues) {
    val items by vm.items.collectAsState()
    val categories by vm.categories.collectAsState()
    val cart by vm.cart.collectAsState()
    val selectedCategory by vm.category.collectAsState()
    val search by vm.search.collectAsState()
    val statusLine by vm.statusLine.collectAsState()
    val busy by vm.busy.collectAsState()
    val lastSale by vm.lastSale.collectAsState()
    val pendingCount by vm.pendingSyncCount.collectAsState()
    val fiscalFailed by vm.fiscalFailedCount.collectAsState()

    var modifierTarget by remember { mutableStateOf<MenuItemEntity?>(null) }
    var showCashDialog by remember { mutableStateOf(false) }

    val visible = remember(items, selectedCategory, search) {
        items.filter { item ->
            (selectedCategory == null || item.categoryId == selectedCategory) &&
                (search.isBlank() || item.name.contains(search, ignoreCase = true))
        }
    }

    Row(Modifier.fillMaxSize().padding(padding)) {

        // ── Левая часть: меню ──────────────────────────────────────────────
        Column(Modifier.weight(1.6f).fillMaxHeight().padding(12.dp)) {

            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        "Касса",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        statusLine,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                if (pendingCount > 0) {
                    TextButton(onClick = { vm.forceSync() }) {
                        Text("Отправить ($pendingCount)")
                    }
                }
                IconButton(onClick = { vm.syncMenu() }) {
                    Icon(Icons.Default.Refresh, contentDescription = "Обновить меню")
                }
                TextButton(onClick = { vm.navigate(Screen.SHIFT) }) { Text("Смена") }
                TextButton(onClick = { vm.navigate(Screen.JOURNAL) }) {
                    Text(if (fiscalFailed > 0) "Журнал ($fiscalFailed!)" else "Журнал")
                }
                TextButton(onClick = { vm.navigate(Screen.SETTINGS) }) { Text("Настройки") }
            }

            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = search,
                onValueChange = vm::setSearch,
                placeholder = { Text("Поиск по меню") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )

            Spacer(Modifier.height(8.dp))
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                item {
                    FilterChip(
                        selected = selectedCategory == null,
                        onClick = { vm.selectCategory(null) },
                        label = { Text("Все") }
                    )
                }
                items(categories, key = { it.id }) { cat ->
                    FilterChip(
                        selected = selectedCategory == cat.id,
                        onClick = { vm.selectCategory(cat.id) },
                        label = { Text(cat.name) }
                    )
                }
            }

            Spacer(Modifier.height(8.dp))
            if (items.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            "Меню не загружено",
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Spacer(Modifier.height(8.dp))
                        Button(onClick = { vm.syncMenu() }) { Text("Загрузить меню") }
                    }
                }
            } else {
                LazyVerticalGrid(
                    columns = GridCells.Adaptive(minSize = 150.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.fillMaxSize()
                ) {
                    items(visible, key = { it.id }) { item ->
                        MenuItemCard(
                            item = item,
                            onClick = {
                                // Если у позиции есть добавки — спрашиваем, иначе сразу в чек
                                modifierTarget = item
                            }
                        )
                    }
                }
            }
        }

        Divider(
            Modifier.width(1.dp).fillMaxHeight(),
            color = MaterialTheme.colorScheme.surfaceVariant
        )

        // ── Правая часть: чек ──────────────────────────────────────────────
        Column(Modifier.weight(1f).fillMaxHeight().padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Чек",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f)
                )
                if (!cart.isEmpty) {
                    IconButton(onClick = { vm.clearCart() }) {
                        Icon(Icons.Default.Delete, contentDescription = "Очистить чек")
                    }
                }
            }

            OrderTypeSelector(vm)

            Spacer(Modifier.height(8.dp))
            if (cart.isEmpty) {
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Text(
                        "Выберите позиции",
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            } else {
                LazyColumn(
                    Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    items(cart.lines, key = { it.mergeKey }) { line ->
                        CartLineRow(line, vm)
                    }
                }
            }

            Divider(Modifier.padding(vertical = 8.dp))
            Row(Modifier.fillMaxWidth()) {
                Text("ИТОГО", fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                Text(
                    Money.format(cart.totalKopecks),
                    fontWeight = FontWeight.Bold,
                    style = MaterialTheme.typography.titleLarge
                )
            }

            Spacer(Modifier.height(12.dp))
            Button(
                onClick = { showCashDialog = true },
                enabled = !cart.isEmpty && !busy,
                modifier = Modifier.fillMaxWidth().height(56.dp)
            ) {
                if (busy) CircularProgressIndicator(
                    Modifier.size(20.dp),
                    strokeWidth = 2.dp
                ) else Text("Наличные", style = MaterialTheme.typography.titleMedium)
            }
            Spacer(Modifier.height(8.dp))
            OutlinedButton(
                onClick = { vm.pay("card") },
                enabled = !cart.isEmpty && !busy,
                modifier = Modifier.fillMaxWidth().height(56.dp)
            ) {
                Text("Карта", style = MaterialTheme.typography.titleMedium)
            }
        }
    }

    // ── Диалоги ────────────────────────────────────────────────────────────
    modifierTarget?.let { item ->
        ModifierDialog(
            vm = vm,
            item = item,
            onDismiss = { modifierTarget = null }
        )
    }

    if (showCashDialog) {
        CashDialog(
            totalKopecks = cart.totalKopecks,
            onDismiss = { showCashDialog = false },
            onConfirm = { got ->
                showCashDialog = false
                vm.pay("cash", got)
            }
        )
    }

    lastSale?.let { outcome ->
        SaleDoneDialog(outcome = outcome, onDismiss = { vm.dismissSaleOutcome() })
    }
}

@Composable
private fun MenuItemCard(item: MenuItemEntity, onClick: () -> Unit) {
    val stopped = item.isStopped()
    Card(
        onClick = onClick,
        enabled = !stopped,
        colors = CardDefaults.cardColors(
            containerColor = if (stopped) MaterialTheme.colorScheme.surfaceVariant
            else MaterialTheme.colorScheme.surface
        ),
        modifier = Modifier.height(96.dp)
    ) {
        Column(Modifier.padding(10.dp).fillMaxSize()) {
            Text(
                item.name,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f)
            )
            Text(
                if (stopped) "стоп-лист" else Money.format(item.priceKopecks),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
                color = if (stopped) MaterialTheme.colorScheme.error
                else MaterialTheme.colorScheme.primary
            )
        }
    }
}

@Composable
private fun CartLineRow(line: CartLine, vm: PosViewModel) {
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(line.name, style = MaterialTheme.typography.bodyMedium)
                if (line.modifiers.isNotEmpty()) {
                    Text(
                        "+ " + line.modifiers.joinToString(", ") { it.name },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            IconButton(onClick = { vm.changeQuantity(line.mergeKey, -1) }) {
                Icon(Icons.Default.Remove, contentDescription = "Меньше")
            }
            Text(line.quantity.toString(), fontWeight = FontWeight.Bold)
            IconButton(onClick = { vm.changeQuantity(line.mergeKey, 1) }) {
                Icon(Icons.Default.Add, contentDescription = "Больше")
            }
            Text(
                Money.format(line.sumKopecks),
                modifier = Modifier.width(96.dp),
                fontWeight = FontWeight.SemiBold
            )
        }
    }
}

@Composable
private fun OrderTypeSelector(vm: PosViewModel) {
    val current by vm.orderType.collectAsState()
    val types = listOf("pickup" to "С собой", "dine_in" to "В зале", "delivery" to "Доставка")
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        types.forEach { (code, title) ->
            FilterChip(
                selected = current == code,
                onClick = { vm.setOrderType(code) },
                label = { Text(title) }
            )
        }
    }
}

/** Выбор добавок. Если их нет — сразу добавляем позицию в чек. */
@Composable
private fun ModifierDialog(vm: PosViewModel, item: MenuItemEntity, onDismiss: () -> Unit) {
    var mods by remember(item.id) { mutableStateOf<List<ModifierEntity>?>(null) }
    var selected by remember(item.id) { mutableStateOf(setOf<String>()) }

    LaunchedEffect(item.id) {
        val loaded = vm.modifiersFor(item.id)
        if (loaded.isEmpty()) {
            vm.addToCart(item)
            onDismiss()
        } else {
            mods = loaded
        }
    }

    val list = mods ?: return

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(item.name) },
        text = {
            Column {
                Text(
                    "Добавки",
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(Modifier.height(8.dp))
                list.forEach { m ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                selected = if (m.id in selected) selected - m.id else selected + m.id
                            }
                            .padding(vertical = 8.dp)
                    ) {
                        val on = m.id in selected
                        Box(
                            Modifier
                                .size(20.dp)
                                .background(
                                    if (on) MaterialTheme.colorScheme.primary
                                    else MaterialTheme.colorScheme.surfaceVariant,
                                    RoundedCornerShape(4.dp)
                                )
                        )
                        Spacer(Modifier.width(10.dp))
                        Text(m.name, Modifier.weight(1f))
                        Text(
                            if (m.priceAdjustmentKopecks == 0L) "—"
                            else "+" + Money.format(m.priceAdjustmentKopecks)
                        )
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = {
                vm.addToCart(item, list.filter { it.id in selected })
                onDismiss()
            }) { Text("В чек") }
        },
        dismissButton = {
            TextButton(onClick = {
                vm.addToCart(item)
                onDismiss()
            }) { Text("Без добавок") }
        }
    )
}

/** Ввод полученной суммы и расчёт сдачи. */
@Composable
private fun CashDialog(
    totalKopecks: Long,
    onDismiss: () -> Unit,
    onConfirm: (Long) -> Unit
) {
    var text by remember { mutableStateOf("") }
    val got = Money.parse(text)
    val change = (got ?: 0L) - totalKopecks
    val enough = got != null && change >= 0

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Оплата наличными") },
        text = {
            Column {
                Text("К оплате: " + Money.format(totalKopecks))
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    label = { Text("Получено") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Decimal,
                        imeAction = ImeAction.Done
                    ),
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    if (got == null) "Введите сумму"
                    else if (change < 0) "Не хватает " + Money.format(-change)
                    else "Сдача: " + Money.format(change),
                    color = if (got != null && change < 0) MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.onSurface,
                    fontWeight = FontWeight.Bold
                )
                Spacer(Modifier.height(8.dp))
                TextButton(onClick = { text = (totalKopecks / 100.0).toString() }) {
                    Text("Без сдачи")
                }
            }
        },
        confirmButton = {
            Button(onClick = { onConfirm(got!!) }, enabled = enough) { Text("Пробить чек") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Отмена") }
        }
    )
}
