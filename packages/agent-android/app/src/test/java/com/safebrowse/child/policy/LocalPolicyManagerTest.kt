package com.safebrowse.child.policy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Unit test suite verifying SafeSearch, YouTube Restricted Mode,
 * and policy precedence parity on the Android agent.
 */
class LocalPolicyManagerTest {

    private val fixedNow = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }.parse("2026-09-17T10:00:00")!!

    private val futureExpiry = "2026-09-17T10:30:00"
    private val pastExpiry = "2026-09-17T09:30:00"

    @Test
    fun `test Google SafeSearch rewrite to VIP`() {
        val policy = Policy(
            id = "pol-1",
            childId = "child-1",
            version = 1,
            isPaused = false,
            safeSearch = SafeSearchConfig(googleSafeSearch = true)
        )
        val manager = LocalPolicyManager(policy)

        val decisionDirect = manager.evaluate("google.com", fixedNow)
        assertEquals("ALLOW", decisionDirect.action)
        assertEquals("SAFESEARCH_REWRITE", decisionDirect.reason)
        assertEquals("216.239.38.120", decisionDirect.rewriteIp)

        val decisionWww = manager.evaluate("www.google.com", fixedNow)
        assertEquals("216.239.38.120", decisionWww.rewriteIp)

        val decisionSub = manager.evaluate("sub.google.com", fixedNow)
        assertEquals("216.239.38.120", decisionSub.rewriteIp)
    }

    @Test
    fun `test Bing SafeSearch rewrite to VIP`() {
        val policy = Policy(
            id = "pol-2",
            childId = "child-1",
            version = 1,
            isPaused = false,
            safeSearch = SafeSearchConfig(bingSafeSearch = true)
        )
        val manager = LocalPolicyManager(policy)

        val decision = manager.evaluate("bing.com", fixedNow)
        assertEquals("ALLOW", decision.action)
        assertEquals("SAFESEARCH_REWRITE", decision.reason)
        assertEquals("204.79.197.220", decision.rewriteIp)
    }

    @Test
    fun `test DuckDuckGo SafeSearch rewrite to VIP`() {
        val policy = Policy(
            id = "pol-3",
            childId = "child-1",
            version = 1,
            isPaused = false,
            safeSearch = SafeSearchConfig(duckDuckGoSafeSearch = true)
        )
        val manager = LocalPolicyManager(policy)

        val decision = manager.evaluate("duckduckgo.com", fixedNow)
        assertEquals("ALLOW", decision.action)
        assertEquals("SAFESEARCH_REWRITE", decision.reason)
        assertEquals("52.142.124.215", decision.rewriteIp)
    }

    @Test
    fun `test YouTube Restricted Mode rewrite to VIP when active`() {
        val policy = Policy(
            id = "pol-4",
            childId = "child-1",
            version = 1,
            isPaused = false,
            safeSearch = SafeSearchConfig(youtubeRestrictedMode = "STRICT")
        )
        val manager = LocalPolicyManager(policy)

        val decisionYt = manager.evaluate("youtube.com", fixedNow)
        assertEquals("ALLOW", decisionYt.action)
        assertEquals("SAFESEARCH_REWRITE", decisionYt.reason)
        assertEquals("216.239.38.119", decisionYt.rewriteIp)

        val decisionApi = manager.evaluate("youtubei.googleapis.com", fixedNow)
        assertEquals("216.239.38.119", decisionApi.rewriteIp)
    }

    @Test
    fun `test YouTube Restricted Mode OFF does not rewrite`() {
        val policy = Policy(
            id = "pol-5",
            childId = "child-1",
            version = 1,
            isPaused = false,
            safeSearch = SafeSearchConfig(youtubeRestrictedMode = "OFF")
        )
        val manager = LocalPolicyManager(policy)

        val decision = manager.evaluate("youtube.com", fixedNow)
        assertEquals("ALLOW", decision.action)
        assertEquals("DEFAULT_ALLOW", decision.reason)
        assertNull(decision.rewriteIp)
    }

    @Test
    fun `test normal allowed domain is not rewritten`() {
        val policy = Policy(
            id = "pol-6",
            childId = "child-1",
            version = 1,
            isPaused = false,
            safeSearch = SafeSearchConfig(googleSafeSearch = true, youtubeRestrictedMode = "STRICT")
        )
        val manager = LocalPolicyManager(policy)

        val decision = manager.evaluate("wikipedia.org", fixedNow)
        assertEquals("ALLOW", decision.action)
        assertEquals("DEFAULT_ALLOW", decision.reason)
        assertNull(decision.rewriteIp)
    }

    @Test
    fun `test explicit blocked domain takes precedence over SafeSearch rewrite`() {
        val policy = Policy(
            id = "pol-7",
            childId = "child-1",
            version = 1,
            isPaused = false,
            rules = listOf(
                PolicyRule(id = "r-block-yt", domain = "youtube.com", action = "BLOCK", reason = "Blocked by parent")
            ),
            safeSearch = SafeSearchConfig(youtubeRestrictedMode = "STRICT")
        )
        val manager = LocalPolicyManager(policy)

        val decision = manager.evaluate("youtube.com", fixedNow)
        assertEquals("BLOCK", decision.action)
        assertEquals("EXPLICIT_BLOCK", decision.reason)
        assertNull(decision.rewriteIp)
    }

    @Test
    fun `test Internet Pause takes top precedence over all rules and SafeSearch`() {
        val policy = Policy(
            id = "pol-8",
            childId = "child-1",
            version = 1,
            isPaused = true,
            rules = listOf(
                PolicyRule(id = "r-temp", domain = "google.com", action = "TEMPORARY_ALLOW", expiresAt = futureExpiry),
                PolicyRule(id = "r-allow", domain = "wikipedia.org", action = "ALLOW")
            ),
            safeSearch = SafeSearchConfig(googleSafeSearch = true)
        )
        val manager = LocalPolicyManager(policy)

        val decisionGoogle = manager.evaluate("google.com", fixedNow)
        assertEquals("BLOCK", decisionGoogle.action)
        assertEquals("PAUSED_INTERNET", decisionGoogle.reason)
        assertNull(decisionGoogle.rewriteIp)

        val decisionWiki = manager.evaluate("wikipedia.org", fixedNow)
        assertEquals("BLOCK", decisionWiki.action)
        assertEquals("PAUSED_INTERNET", decisionWiki.reason)
    }

    @Test
    fun `test temporary allow applies SafeSearch rewrite when active`() {
        val policy = Policy(
            id = "pol-9",
            childId = "child-1",
            version = 1,
            isPaused = false,
            rules = listOf(
                PolicyRule(id = "r-temp", domain = "google.com", action = "TEMPORARY_ALLOW", expiresAt = futureExpiry),
                PolicyRule(id = "r-block", domain = "google.com", action = "BLOCK")
            ),
            safeSearch = SafeSearchConfig(googleSafeSearch = true)
        )
        val manager = LocalPolicyManager(policy)

        val decision = manager.evaluate("google.com", fixedNow)
        assertEquals("ALLOW", decision.action)
        assertEquals("TEMPORARY_ALLOW", decision.reason)
        assertEquals("216.239.38.120", decision.rewriteIp)
    }

    @Test
    fun `test expired temporary allow falls back to explicit block`() {
        val policy = Policy(
            id = "pol-10",
            childId = "child-1",
            version = 1,
            isPaused = false,
            rules = listOf(
                PolicyRule(id = "r-temp", domain = "google.com", action = "TEMPORARY_ALLOW", expiresAt = pastExpiry),
                PolicyRule(id = "r-block", domain = "google.com", action = "BLOCK")
            ),
            safeSearch = SafeSearchConfig(googleSafeSearch = true)
        )
        val manager = LocalPolicyManager(policy)

        val decision = manager.evaluate("google.com", fixedNow)
        assertEquals("BLOCK", decision.action)
        assertEquals("EXPLICIT_BLOCK", decision.reason)
        assertNull(decision.rewriteIp)
    }

    @Test
    fun `test Google ccTLD domains rewrite to SafeSearch VIP`() {
        val policy = Policy(
            id = "pol-11",
            childId = "child-1",
            version = 1,
            isPaused = false,
            safeSearch = SafeSearchConfig(googleSafeSearch = true)
        )
        val manager = LocalPolicyManager(policy)

        val decisionUk = manager.evaluate("google.co.uk", fixedNow)
        assertEquals("216.239.38.120", decisionUk.rewriteIp)

        val decisionCa = manager.evaluate("www.google.ca", fixedNow)
        assertEquals("216.239.38.120", decisionCa.rewriteIp)
    }

    @Test
    fun `test AgentConfig URL validation rejects blank and malformed URLs`() {
        org.junit.Assert.assertThrows(IllegalArgumentException::class.java) {
            com.safebrowse.child.config.AgentConfig.validateApiBaseUrl("", isDebug = true)
        }
        org.junit.Assert.assertThrows(IllegalArgumentException::class.java) {
            com.safebrowse.child.config.AgentConfig.validateApiBaseUrl("   ", isDebug = true)
        }
        org.junit.Assert.assertThrows(IllegalArgumentException::class.java) {
            com.safebrowse.child.config.AgentConfig.validateApiBaseUrl("not a url", isDebug = true)
        }
        org.junit.Assert.assertThrows(IllegalArgumentException::class.java) {
            com.safebrowse.child.config.AgentConfig.validateApiBaseUrl("ftp://10.0.2.2:11002", isDebug = true)
        }
    }

    @Test
    fun `test AgentConfig rejects cleartext HTTP in production builds`() {
        org.junit.Assert.assertThrows(IllegalArgumentException::class.java) {
            com.safebrowse.child.config.AgentConfig.validateApiBaseUrl("http://10.0.2.2:11002", isDebug = false)
        }
        org.junit.Assert.assertThrows(IllegalArgumentException::class.java) {
            com.safebrowse.child.config.AgentConfig.validateApiBaseUrl("http://100.64.0.1:11002", isDebug = false)
        }
        val validHttps = com.safebrowse.child.config.AgentConfig.validateApiBaseUrl("https://safebrowse.example.com", isDebug = false)
        assertEquals("https://safebrowse.example.com", validHttps)
    }

    @Test
    fun `test AgentConfig restricts HTTP in debug to approved development and Tailscale CGNAT endpoints`() {
        // Approved endpoints
        assertEquals("http://10.0.2.2:11002", com.safebrowse.child.config.AgentConfig.validateApiBaseUrl("http://10.0.2.2:11002/", isDebug = true))
        assertEquals("http://127.0.0.1:11002", com.safebrowse.child.config.AgentConfig.validateApiBaseUrl("http://127.0.0.1:11002", isDebug = true))
        assertEquals("http://localhost:11002", com.safebrowse.child.config.AgentConfig.validateApiBaseUrl("http://localhost:11002", isDebug = true))
        assertEquals("http://100.64.0.1:11002", com.safebrowse.child.config.AgentConfig.validateApiBaseUrl("http://100.64.0.1:11002", isDebug = true))
        assertEquals("http://100.127.255.254:11002", com.safebrowse.child.config.AgentConfig.validateApiBaseUrl("http://100.127.255.254:11002", isDebug = true))

        // Disallowed HTTP hosts outside approved development scope
        org.junit.Assert.assertThrows(IllegalArgumentException::class.java) {
            com.safebrowse.child.config.AgentConfig.validateApiBaseUrl("http://example.com", isDebug = true)
        }
        org.junit.Assert.assertThrows(IllegalArgumentException::class.java) {
            com.safebrowse.child.config.AgentConfig.validateApiBaseUrl("http://100.63.255.254:11002", isDebug = true)
        }
        org.junit.Assert.assertThrows(IllegalArgumentException::class.java) {
            com.safebrowse.child.config.AgentConfig.validateApiBaseUrl("http://100.128.0.1:11002", isDebug = true)
        }
    }

    @Test
    fun `test isEnrolled and isPaired return false without context or credentials`() {
        val manager = LocalPolicyManager()
        assertEquals(false, manager.isEnrolled())
        assertEquals(false, manager.isPaired())
    }
}
