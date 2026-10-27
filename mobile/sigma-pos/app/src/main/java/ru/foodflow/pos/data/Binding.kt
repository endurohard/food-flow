package ru.foodflow.pos.data

/**
 * Код привязки терминала к организации.
 *
 * APK один на всю платформу, поэтому адрес сервера касса получает при
 * первом запуске: сканированием QR со страницы скачивания либо вводом
 * короткого кода вручную (QR не читается — камера залита светом, терминал
 * без камеры). Разбор вынесен в чистый Kotlin без android.net.Uri, чтобы
 * покрывался обычными unit-тестами: ошибка здесь означает кассу, которая
 * стучится не на тот сервер.
 *
 * Принимаются три формы:
 *   ffpos://setup?api=https://jezva.food-flow.ru&org=Джезва&sub=jezva
 *   https://jezva.food-flow.ru            (адрес из браузера, с путём и без)
 *   jezva                                 (метка организации + базовый домен)
 */
data class BindingTarget(
    /** Базовый URL API без завершающего слэша. */
    val apiBase: String,
    /** Метка организации из адреса, если её удалось выделить. */
    val subdomain: String?,
    /** Человеческое имя организации из QR; на экране показывается до входа. */
    val orgName: String?
)

object Binding {

    /** Схема нашего QR. Совпадает с intent-filter в манифесте. */
    const val SCHEME = "ffpos"

    /**
     * Метка DNS: то же правило, что в CHECK миграции 029 на сервере.
     * Длина 2..63, только [a-z0-9-], не начинается и не кончается дефисом.
     */
    private val LABEL = Regex("^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$")

    /**
     * @param raw что отсканировали или ввели
     * @param defaultDomain базовый домен платформы для коротких кодов
     *        (`jezva` + `food-flow.ru` → `https://jezva.food-flow.ru`)
     */
    fun parse(raw: String?, defaultDomain: String): BindingTarget? {
        val s = raw?.trim().orEmpty()
        if (s.isEmpty()) return null

        if (s.startsWith("$SCHEME://", ignoreCase = true)) return parseDeepLink(s, defaultDomain)
        if (s.startsWith("http://", ignoreCase = true) || s.startsWith("https://", ignoreCase = true)) {
            return parseUrl(s)
        }
        // Короткий код: только метка организации
        val label = s.lowercase()
        if (!LABEL.matches(label)) return null
        val domain = defaultDomain.trim().trim('.').lowercase()
        if (domain.isEmpty()) return null
        return BindingTarget("https://$label.$domain", label, null)
    }

    private fun parseDeepLink(s: String, defaultDomain: String): BindingTarget? {
        val query = s.substringAfter('?', "")
        val params = parseQuery(query)
        val api = params["api"] ?: params["url"] ?: params["server"]
        val sub = params["sub"] ?: params["subdomain"]
        val org = params["org"]?.takeIf { it.isNotBlank() }

        // Адрес задан явно — он главный: так сервер может отдать нестандартный домен
        if (!api.isNullOrBlank()) {
            val fromUrl = parseUrl(if (api.startsWith("http")) api else "https://$api") ?: return null
            return fromUrl.copy(subdomain = sub?.lowercase() ?: fromUrl.subdomain, orgName = org)
        }
        // Иначе собираем из метки и базового домена
        val target = parse(sub, defaultDomain) ?: return null
        return target.copy(orgName = org)
    }

    /** Из адреса берём только схему и хост: путь и query к API не относятся. */
    private fun parseUrl(s: String): BindingTarget? {
        val scheme = if (s.startsWith("https://", true)) "https" else "http"
        val rest = s.substringAfter("://", "")
        val authority = rest.substringBefore('/').substringBefore('?').substringBefore('#')
        if (authority.isBlank()) return null
        // Логин:пароль в адресе — не наш случай, а признак подделанной ссылки
        if (authority.contains('@')) return null
        val host = authority.substringBefore(':').lowercase()
        if (host.isBlank() || host.contains(' ')) return null
        val port = authority.substringAfter(':', "").takeIf { it.isNotBlank() }
        if (port != null && port.toIntOrNull() == null) return null

        val base = buildString {
            append(scheme).append("://").append(host)
            if (port != null) append(':').append(port)
        }
        return BindingTarget(base, subdomainOf(host), null)
    }

    /** jezva.food-flow.ru → jezva. Голый домен, www, localhost и IP — не метка. */
    fun subdomainOf(host: String): String? {
        val h = host.lowercase()
        if (h.isBlank() || Regex("^[0-9.]+$").matches(h)) return null
        val labels = h.split('.')
        if (labels.size < 3) return null
        val first = labels.first()
        if (first == "www" || !LABEL.matches(first)) return null
        return first
    }

    private fun parseQuery(query: String): Map<String, String> {
        if (query.isBlank()) return emptyMap()
        val out = HashMap<String, String>()
        for (pair in query.split('&')) {
            if (pair.isBlank()) continue
            val k = pair.substringBefore('=')
            val v = pair.substringAfter('=', "")
            if (k.isBlank()) continue
            out[decode(k).lowercase()] = decode(v)
        }
        return out
    }

    /**
     * percent-decoding вручную: java.net.URLDecoder на Android заменяет '+'
     * на пробел, а в base64-подобных значениях плюс значащий.
     */
    private fun decode(s: String): String {
        if (!s.contains('%')) return s
        val bytes = ArrayList<Byte>(s.length)
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '%' && i + 2 < s.length) {
                val hex = s.substring(i + 1, i + 3).toIntOrNull(16)
                if (hex != null) {
                    bytes.add(hex.toByte())
                    i += 3
                    continue
                }
            }
            // не-ASCII символы в сырой строке оставляем как есть
            for (b in c.toString().toByteArray(Charsets.UTF_8)) bytes.add(b)
            i++
        }
        return String(bytes.toByteArray(), Charsets.UTF_8)
    }
}
