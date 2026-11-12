package dev.whatsup.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdatesTest {
    private val json = """
        {"tag_name":"v0.3","name":"WhatsUp 0.3","assets":[
          {"name":"WhatsUp.exe","size":26257107,"digest":"sha256:87510A4A","browser_download_url":"https://example.com/WhatsUp.exe"},
          {"name":"whatsup.apk","size":3856444,"digest":"sha256:D47D0CD8","browser_download_url":"https://example.com/whatsup.apk"}
        ]}
    """.trimIndent()

    @Test
    fun parsesTheAsset() {
        val release = Updates.parse(json)!!
        assertEquals("0.3", release.version)
        assertEquals("https://example.com/whatsup.apk", release.url)
        assertEquals(3856444L, release.sizeBytes)
        assertEquals("d47d0cd8", release.sha256)
        assertEquals("https://example.com/WhatsUp.exe", Updates.parse(json, "WhatsUp.exe")!!.url)
    }

    @Test
    fun noAssetNoRelease() {
        assertNull(Updates.parse(json, "WhatsUp-linux-x64.tar.gz"))
        assertNull(Updates.parse("""{"tag_name":"v0.3","assets":[]}"""))
    }

    @Test
    fun comparesVersionsByNumber() {
        assertTrue(Updates.isNewer("0.3", "0.2"))
        assertTrue(Updates.isNewer("v0.10", "0.9"))
        assertTrue(Updates.isNewer("1.0", "0.9.5"))
        assertTrue(Updates.isNewer("0.2.1", "0.2"))
        assertFalse(Updates.isNewer("0.2", "0.2"))
        assertFalse(Updates.isNewer("0.2", "0.2.0"))
        assertFalse(Updates.isNewer("0.1", "0.2"))
    }
}
