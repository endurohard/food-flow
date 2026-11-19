package ru.foodflow.pos.ui.screens

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import ru.foodflow.pos.data.CardLink
import ru.foodflow.pos.data.QrCode
import ru.foodflow.pos.ui.CardLinkState

/**
 * «Отправить карту»: QR со ссылкой (гость сканирует камерой прямо с экрана
 * кассы), SMS и «Отправить…» через системный выбор приложения
 * (Telegram, WhatsApp и др.). Касса ничего не отправляет сама — только
 * открывает приложение с готовым текстом.
 */
@Composable
fun CardLinkDialog(state: CardLinkState, onDismiss: () -> Unit) {
    val context = LocalContext.current
    var launchError by remember(state) { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Карта гостя") },
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                when (state) {
                    is CardLinkState.Loading -> {
                        CircularProgressIndicator()
                        Spacer(Modifier.height(8.dp))
                        Text("Получаем ссылку на карту" + (state.customerName?.let { " — $it" } ?: "") + "…")
                    }
                    is CardLinkState.Error -> Text(state.message, color = MaterialTheme.colorScheme.error)
                    is CardLinkState.Ready -> ReadyContent(state.link)
                }
                launchError?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = MaterialTheme.colorScheme.error)
                }
            }
        },
        confirmButton = {
            if (state is CardLinkState.Ready) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    state.link.smsUri?.let { sms ->
                        OutlinedButton(onClick = {
                            launchError = startSafely(context, "Нет приложения для SMS") {
                                Intent(Intent.ACTION_SENDTO, Uri.parse(sms))
                            }
                        }) { Text("SMS") }
                    }
                    Button(onClick = {
                        launchError = startSafely(context, "Нет приложения, чтобы отправить ссылку") {
                            Intent.createChooser(
                                Intent(Intent.ACTION_SEND).apply {
                                    type = "text/plain"
                                    putExtra(Intent.EXTRA_TEXT, state.link.message)
                                },
                                "Отправить карту гостя"
                            )
                        }
                    }) { Text("Отправить…") }
                }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Закрыть") } }
    )
}

@Composable
private fun ReadyContent(link: CardLink) {
    val qr = remember(link.url) { runCatching { qrBitmap(link.url, 480) }.getOrNull() }
    link.customerName?.let { Text(it, style = MaterialTheme.typography.titleMedium) }
    link.cardNumber?.let { Text("Карта № $it", color = MaterialTheme.colorScheme.onSurfaceVariant) }
    Spacer(Modifier.height(8.dp))
    if (qr != null) {
        Image(qr.asImageBitmap(), contentDescription = "QR ссылки на карту", modifier = Modifier.size(240.dp))
        Text("Наведите камеру телефона на код", style = MaterialTheme.typography.bodySmall)
    } else {
        Text("QR построить не удалось — отправьте ссылку кнопками ниже", color = MaterialTheme.colorScheme.error)
    }
}

/** Запуск чужого приложения: нет приложения — сообщение в окне, а не падение кассы. */
private fun startSafely(context: Context, notFound: String, intent: () -> Intent): String? =
    try {
        context.startActivity(intent().addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        null
    } catch (e: ActivityNotFoundException) {
        notFound
    }

private fun qrBitmap(text: String, size: Int): Bitmap {
    val m = QrCode.matrix(text, size)
    val pixels = IntArray(m.size * m.size) { i ->
        if (m.dark[i]) Color.BLACK else Color.WHITE
    }
    return Bitmap.createBitmap(pixels, m.size, m.size, Bitmap.Config.ARGB_8888)
}
