package ru.foodflow.pos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import ru.foodflow.pos.data.Binding

/**
 * Разбор кода привязки терминала к организации. Ошибка здесь означает кассу,
 * которая отправляет чеки и продажи на чужой сервер, поэтому проверяются и
 * корректные формы, и мусор на входе.
 */
class BindingTest {

    private val domain = "food-flow.ru"

    @Test
    fun `короткий код организации разворачивается в адрес`() {
        val t = Binding.parse("jezva", domain)!!
        assertEquals("https://jezva.food-flow.ru", t.apiBase)
        assertEquals("jezva", t.subdomain)
        assertNull(t.orgName)
    }

    @Test
    fun `код приводится к нижнему регистру — DNS регистронезависим`() {
        assertEquals("https://jezva.food-flow.ru", Binding.parse("JEZVA", domain)!!.apiBase)
    }

    @Test
    fun `deep link из QR несёт адрес, метку и имя организации`() {
        val t = Binding.parse(
            "ffpos://setup?api=https%3A%2F%2Fjezva.food-flow.ru&sub=jezva&org=%D0%94%D0%B6%D0%B5%D0%B7%D0%B2%D0%B0",
            domain
        )!!
        assertEquals("https://jezva.food-flow.ru", t.apiBase)
        assertEquals("jezva", t.subdomain)
        assertEquals("Джезва", t.orgName)
    }

    @Test
    fun `deep link без api собирается из метки и базового домена`() {
        val t = Binding.parse("ffpos://setup?sub=jezva&org=Jezva", domain)!!
        assertEquals("https://jezva.food-flow.ru", t.apiBase)
        assertEquals("Jezva", t.orgName)
    }

    @Test
    fun `адрес из браузера теряет путь и query, остаётся база API`() {
        val t = Binding.parse("https://jezva.food-flow.ru/admin-panel/pos-download.html?x=1", domain)!!
        assertEquals("https://jezva.food-flow.ru", t.apiBase)
        assertEquals("jezva", t.subdomain)
    }

    @Test
    fun `порт сохраняется — локальные установки живут не на 443`() {
        val t = Binding.parse("http://192.168.1.10:8080/", domain)!!
        assertEquals("http://192.168.1.10:8080", t.apiBase)
        // IP поддоменом не считается
        assertNull(t.subdomain)
    }

    @Test
    fun `нестандартный домен из api не подменяется базовым`() {
        // У части установок свой домен, собирать адрес из метки нельзя
        val t = Binding.parse("ffpos://setup?api=https://kassa.mycafe.spb.ru&sub=jezva", domain)!!
        assertEquals("https://kassa.mycafe.spb.ru", t.apiBase)
        assertEquals("jezva", t.subdomain)
    }

    @Test
    fun `голый домен и www поддоменом не считаются`() {
        assertNull(Binding.parse("https://food-flow.ru", domain)!!.subdomain)
        assertNull(Binding.parse("https://www.food-flow.ru", domain)!!.subdomain)
    }

    @Test
    fun `мусор и опасные ссылки отвергаются`() {
        assertNull(Binding.parse(null, domain))
        assertNull(Binding.parse("   ", domain))
        // не похоже на метку DNS
        assertNull(Binding.parse("джезва", domain))
        assertNull(Binding.parse("-jezva", domain))
        assertNull(Binding.parse("jezva-", domain))
        assertNull(Binding.parse("a", domain))
        assertNull(Binding.parse("jez va", domain))
        // чужой QR с логином в адресе — признак подделки
        assertNull(Binding.parse("https://user:pass@evil.example.com/", domain))
        assertNull(Binding.parse("https://jezva.food-flow.ru@evil.example.com/", domain))
        // левая схема
        assertNull(Binding.parse("javascript:alert(1)", domain))
    }

    @Test
    fun `короткий код без базового домена не разворачивается`() {
        assertNull(Binding.parse("jezva", ""))
    }

    @Test
    fun `метка организации выделяется из хоста`() {
        assertEquals("jezva", Binding.subdomainOf("jezva.food-flow.ru"))
        assertNull(Binding.subdomainOf("localhost"))
        assertNull(Binding.subdomainOf("10.0.0.1"))
    }
}
