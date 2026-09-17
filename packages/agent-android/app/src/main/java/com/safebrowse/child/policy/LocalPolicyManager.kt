package com.safebrowse.child.policy

import android.content.Context
import com.google.gson.Gson
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

data class PolicyRule(
    val id: String,
    val domain: String,
    val action: String, // "BLOCK", "ALLOW", "TEMPORARY_ALLOW"
    val reason: String? = null,
    val expiresAt: String? = null
)

data class SafeSearchConfig(
    val googleSafeSearch: Boolean = false,
    val bingSafeSearch: Boolean = false,
    val duckDuckGoSafeSearch: Boolean = false,
    val youtubeRestrictedMode: String? = "OFF" // "OFF", "MODERATE", "STRICT"
)

data class Policy(
    val id: String,
    val childId: String,
    val version: Int,
    val isPaused: Boolean,
    val pauseExpiresAt: String? = null,
    val rules: List<PolicyRule> = emptyList(),
    val safeSearch: SafeSearchConfig? = null
)

data class PolicyDecision(
    val action: String, // "BLOCK" or "ALLOW"
    val reason: String,
    val expiresAt: String? = null,
    val rewriteIp: String? = null
)

class LocalPolicyManager {
    private var context: Context? = null
    private var inMemoryPolicy: Policy? = null
    private val gson = Gson()

    constructor(context: Context) {
        this.context = context
    }

    // Constructor for testing without requiring Android Context
    constructor(initialPolicy: Policy? = null) {
        this.inMemoryPolicy = initialPolicy
    }

    fun savePolicy(policy: Policy) {
        inMemoryPolicy = policy
        context?.let { ctx ->
            val prefs = ctx.getSharedPreferences("safebrowse_policy", Context.MODE_PRIVATE)
            prefs.edit().putString("active_policy_json", gson.toJson(policy)).apply()
        }
    }

    fun getPolicy(): Policy? {
        if (inMemoryPolicy != null) return inMemoryPolicy
        val ctx = context ?: return null
        val prefs = ctx.getSharedPreferences("safebrowse_policy", Context.MODE_PRIVATE)
        val json = prefs.getString("active_policy_json", null) ?: return null
        return try {
            val policy = gson.fromJson(json, Policy::class.java)
            inMemoryPolicy = policy
            policy
        } catch (e: Exception) {
            null
        }
    }

    fun normalizeDomain(rawDomain: String): String {
        var d = rawDomain.trim().lowercase(Locale.ROOT)
        if (d.startsWith("http://")) d = d.substring(7)
        if (d.startsWith("https://")) d = d.substring(8)
        if (d.contains("/")) d = d.substring(0, d.indexOf("/"))
        if (d.contains("?")) d = d.substring(0, d.indexOf("?"))
        if (d.contains(":")) d = d.substring(0, d.indexOf(":"))
        if (d.endsWith(".")) d = d.substring(0, d.length - 1)
        if (d.startsWith("www.")) d = d.substring(4)
        return d
    }

    private fun domainMatches(target: String, ruleDomain: String): Boolean {
        if (target == ruleDomain) return true
        if (ruleDomain.startsWith("*.")) {
            val base = ruleDomain.substring(2)
            if (target == base || target.endsWith(".$base")) return true
        }
        if (target.endsWith(".$ruleDomain")) return true
        return false
    }

    private fun parseIsoDate(isoString: String): Date? {
        return try {
            val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US)
            sdf.timeZone = TimeZone.getTimeZone("UTC")
            sdf.parse(isoString)
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Checks if the domain requires SafeSearch / YouTube Restricted DNS rewriting.
     * Matches Windows dns-proxy.ts behavior and VIP mappings exactly:
     * - Google SafeSearch: forcesafesearch.google.com -> 216.239.38.120
     * - Bing Strict SafeSearch: strict.bing.com -> 204.79.197.220
     * - DuckDuckGo SafeSearch: safe.duckduckgo.com -> 52.142.124.215
     * - YouTube Restricted Mode: restrict.youtube.com -> 216.239.38.119
     */
    fun checkSafeSearchRewrite(targetDomain: String, policy: Policy): String? {
        val safeSearch = policy.safeSearch ?: return null
        val lower = normalizeDomain(targetDomain)

        // 1. Google SafeSearch: forcesafesearch.google.com (216.239.38.120)
        if (safeSearch.googleSafeSearch && (lower == "google.com" || lower.endsWith(".google.com") || lower.startsWith("google.") || lower.startsWith("www.google."))) {
            return "216.239.38.120"
        }

        // 2. Bing Strict SafeSearch: strict.bing.com (204.79.197.220)
        if (safeSearch.bingSafeSearch && (lower == "bing.com" || lower.endsWith(".bing.com"))) {
            return "204.79.197.220"
        }

        // 3. DuckDuckGo SafeSearch: safe.duckduckgo.com (52.142.124.215)
        if (safeSearch.duckDuckGoSafeSearch && (lower == "duckduckgo.com" || lower.endsWith(".duckduckgo.com"))) {
            return "52.142.124.215"
        }

        // 4. YouTube Restricted Mode: restrict.youtube.com (216.239.38.119)
        if (safeSearch.youtubeRestrictedMode != null &&
            safeSearch.youtubeRestrictedMode != "OFF" &&
            (lower == "youtube.com" || lower.endsWith(".youtube.com") || lower == "youtubei.googleapis.com")
        ) {
            return "216.239.38.119"
        }

        return null
    }

    /**
     * Evaluates domain against policy hierarchy with strict precedence:
     * 1. Global Internet Pause (Level 1: top priority block)
     * 2. Active Temporary Allow (Level 2: time-bounded access, applies SafeSearch rewrite if relevant)
     * 3. Explicit Whitelist (Level 3: explicit ALLOW rule, applies SafeSearch rewrite if relevant)
     * 4. Explicit Blacklist (Level 4: explicit BLOCK rule, authoritative over SafeSearch rewrite)
     * 5. Default Fallback (Level 5: applies SafeSearch rewrite if configured; otherwise DEFAULT_ALLOW)
     */
    fun evaluate(targetDomain: String, currentTime: Date = Date()): PolicyDecision {
        val policy = getPolicy() ?: return PolicyDecision("ALLOW", "DEFAULT_ALLOW")
        val norm = normalizeDomain(targetDomain)
        val now = currentTime

        // 1. Check Global Pause
        if (policy.isPaused) {
            if (policy.pauseExpiresAt != null) {
                val expiry = parseIsoDate(policy.pauseExpiresAt)
                if (expiry != null && now.before(expiry)) {
                    return PolicyDecision("BLOCK", "PAUSED_INTERNET", policy.pauseExpiresAt)
                }
            } else {
                return PolicyDecision("BLOCK", "PAUSED_INTERNET")
            }
        }

        // 2. Check Temporary Approvals
        val tempRule = policy.rules.find { r ->
            r.action == "TEMPORARY_ALLOW" && domainMatches(norm, r.domain) && r.expiresAt != null
        }
        if (tempRule != null) {
            val expiry = parseIsoDate(tempRule.expiresAt!!)
            if (expiry != null && now.before(expiry)) {
                val rewriteIp = checkSafeSearchRewrite(norm, policy)
                return PolicyDecision("ALLOW", "TEMPORARY_ALLOW", tempRule.expiresAt, rewriteIp = rewriteIp)
            }
        }

        // 3. Check Explicit Whitelist
        val allowRule = policy.rules.find { it.action == "ALLOW" && domainMatches(norm, it.domain) }
        if (allowRule != null) {
            val rewriteIp = checkSafeSearchRewrite(norm, policy)
            return PolicyDecision("ALLOW", "EXPLICIT_ALLOW", rewriteIp = rewriteIp)
        }

        // 4. Check Explicit Blacklist (Authoritative over SafeSearch rewrite)
        val blockRule = policy.rules.find { it.action == "BLOCK" && domainMatches(norm, it.domain) }
        if (blockRule != null) {
            return PolicyDecision("BLOCK", "EXPLICIT_BLOCK")
        }

        // 5. Default Fallback with SafeSearch / YouTube VIP rewrite
        val rewriteIp = checkSafeSearchRewrite(norm, policy)
        if (rewriteIp != null) {
            return PolicyDecision("ALLOW", "SAFESEARCH_REWRITE", rewriteIp = rewriteIp)
        }

        return PolicyDecision("ALLOW", "DEFAULT_ALLOW")
    }
}
