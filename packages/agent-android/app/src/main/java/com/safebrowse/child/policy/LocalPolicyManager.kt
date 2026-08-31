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

data class Policy(
    val id: String,
    val childId: String,
    val version: Int,
    val isPaused: Boolean,
    val pauseExpiresAt: String? = null,
    val rules: List<PolicyRule> = emptyList()
)

data class PolicyDecision(
    val action: String, // "BLOCK" or "ALLOW"
    val reason: String,
    val expiresAt: String? = null
)

class LocalPolicyManager(private val context: Context) {
    private val prefs = context.getSharedPreferences("safebrowse_policy", Context.MODE_PRIVATE)
    private val gson = Gson()

    fun savePolicy(policy: Policy) {
        prefs.edit().putString("active_policy_json", gson.toJson(policy)).apply()
    }

    fun getPolicy(): Policy? {
        val json = prefs.getString("active_policy_json", null) ?: return null
        return try {
            gson.fromJson(json, Policy::class.java)
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

    fun evaluate(targetDomain: String): PolicyDecision {
        val policy = getPolicy() ?: return PolicyDecision("ALLOW", "DEFAULT_ALLOW")
        val norm = normalizeDomain(targetDomain)
        val now = Date()

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
                return PolicyDecision("ALLOW", "TEMPORARY_ALLOW", tempRule.expiresAt)
            }
        }

        // 3. Check Explicit Whitelist
        val allowRule = policy.rules.find { it.action == "ALLOW" && domainMatches(norm, it.domain) }
        if (allowRule != null) {
            return PolicyDecision("ALLOW", "EXPLICIT_ALLOW")
        }

        // 4. Check Explicit Blacklist
        val blockRule = policy.rules.find { it.action == "BLOCK" && domainMatches(norm, it.domain) }
        if (blockRule != null) {
            return PolicyDecision("BLOCK", "EXPLICIT_BLOCK")
        }

        // 5. Default Fallback
        return PolicyDecision("ALLOW", "DEFAULT_ALLOW")
    }
}
