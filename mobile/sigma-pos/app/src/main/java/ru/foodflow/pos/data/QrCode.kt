package ru.foodflow.pos.data

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/**
 * QR ссылки на карту гостя. zxing core уже в сборке транзитивно через
 * zxing-android-embedded (сканер привязки), новой зависимости не нужно.
 * Без Android-классов — чтобы проверялось обычным JUnit.
 */
object QrCode {
    class Matrix(val size: Int, val dark: BooleanArray)

    fun matrix(text: String, size: Int): Matrix {
        val hints = mapOf(
            EncodeHintType.CHARACTER_SET to "UTF-8",
            // M — запас на блики экрана кассы при сканировании телефоном
            EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
            EncodeHintType.MARGIN to 2
        )
        val bits = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, hints)
        val n = bits.width
        return Matrix(n, BooleanArray(n * n) { i -> bits.get(i % n, i / n) })
    }
}
