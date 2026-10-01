package com.safebrowse.child.policy

import android.content.Context
import com.google.gson.Gson
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

data class PolicyRule(
    val id: String,
    val domain: String,
    val action: String, // "BLOCK", "ALLOW", "TEMPORARY_ALLOW"
    val reason: String? = null,
    val expiresAt: String? = null,
    val category: String? = null
)

data class CategoryControl(
    val category: String,
    val action: String // "BLOCK", "ALLOW", "RESTRICT"
)

data class BedtimeSchedule(
    val enabled: Boolean = false,
    val startHour: Int = 21,
    val startMinute: Int = 0,
    val endHour: Int = 7,
    val endMinute: Int = 0,
    val allowEducationalOnly: Boolean = false
)

data class StudyMode(
    val active: Boolean = false,
    val expiresAt: String? = null,
    val allowedCategories: List<String> = emptyList()
)

data class UsageBudget(
    val id: String,
    val childId: String,
    val targetType: String, // "DOMAIN", "CATEGORY", "APP"
    val target: String,
    val dailyLimitSeconds: Int,
    val bonusSeconds: Int? = 0,
    val unlimitedToday: Boolean? = false,
    val timezone: String? = "UTC",
    val resetTime: String? = "00:00",
    val enabled: Boolean = true
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
    val familyId: String? = null,
    val version: Int,
    val isPaused: Boolean = false,
    val pauseExpiresAt: String? = null,
    val essentialAllowList: List<String> = emptyList(),
    val studyMode: StudyMode? = null,
    val bedtime: BedtimeSchedule? = null,
    val categoryControls: List<CategoryControl> = emptyList(),
    val rules: List<PolicyRule> = emptyList(),
    val usageBudgets: List<UsageBudget> = emptyList(),
    val safeSearch: SafeSearchConfig? = null
)

data class PolicyDecision(
    val action: String, // "BLOCK" or "ALLOW"
    val reason: String,
    val expiresAt: String? = null,
    val rewriteIp: String? = null,
    val category: String? = null
)

class LocalPolicyManager {
    private var context: Context? = null
    private var inMemoryPolicy: Policy? = null
    private val inMemoryUsage = mutableMapOf<String, Int>()
    private val gson = Gson()

    constructor(context: Context) {
        this.context = context
    }

    // Constructor for testing without requiring Android Context
    constructor(initialPolicy: Policy? = null) {
        this.inMemoryPolicy = initialPolicy
    }

    /**
     * Checks if the device has valid persisted credentials (device_id and device_token)
     * in SharedPreferences ("safebrowse_device").
     */
    fun isEnrolled(): Boolean {
        val ctx = context ?: return false
        val prefs = ctx.getSharedPreferences("safebrowse_device", Context.MODE_PRIVATE)
        val deviceId = prefs.getString("device_id", null)
        val deviceToken = prefs.getString("device_token", null)
        return !deviceId.isNullOrBlank() && !deviceToken.isNullOrBlank()
    }

    /**
     * Alias for isEnrolled() for backward compatibility with onboarding flows.
     */
    fun isPaired(): Boolean = isEnrolled()

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

    fun getConsumedUsageSeconds(target: String, targetType: String): Int {
        val key = "${targetType}_$target".lowercase(Locale.ROOT)
        val ctx = context ?: return inMemoryUsage.getOrDefault(key, 0)
        val prefs = ctx.getSharedPreferences("safebrowse_usage", Context.MODE_PRIVATE)
        return prefs.getInt("consumed_$key", inMemoryUsage.getOrDefault(key, 0))
    }

    fun recordLocalUsage(target: String, targetType: String, seconds: Int) {
        val key = "${targetType}_$target".lowercase(Locale.ROOT)
        inMemoryUsage[key] = (inMemoryUsage[key] ?: 0) + seconds
        context?.let { ctx ->
            val prefs = ctx.getSharedPreferences("safebrowse_usage", Context.MODE_PRIVATE)
            val current = prefs.getInt("consumed_$key", 0)
            prefs.edit().putInt("consumed_$key", current + seconds).apply()
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
     * Checks if current time falls within a Bedtime schedule
     */
    fun isWithinBedtime(currentTime: Date, bedtime: BedtimeSchedule): Boolean {
        val cal = Calendar.getInstance()
        cal.time = currentTime
        val currentMinutes = cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE)
        val startMinutes = bedtime.startHour * 60 + bedtime.startMinute
        val endMinutes = bedtime.endHour * 60 + bedtime.endMinute

        return if (startMinutes > endMinutes) {
            currentMinutes >= startMinutes || currentMinutes < endMinutes
        } else {
            currentMinutes in startMinutes until endMinutes
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
     * Evaluates domain against policy hierarchy with strict parity to @safebrowse/shared:
     * 1. Essential Allow List (Always Available, overrides Pause & Study Mode)
     * 2. Global Internet Pause (Level 2: top priority block)
     * 3. Screen Time / Usage Budget Limits (Level 3: DOMAIN and CATEGORY limits)
     * 4. Active Temporary Allow (Level 4: time-bounded access, applies SafeSearch rewrite if relevant)
     * 5. Explicit Whitelist (Level 5: explicit ALLOW rule, applies SafeSearch rewrite if relevant)
     * 6. Explicit Blacklist (Level 6: explicit BLOCK rule, authoritative over SafeSearch rewrite)
     * 7. Study Mode (Level 7: restricts non-educational domains)
     * 8. Bedtime Schedule (Level 8: blocks non-essential domains during curfew hours)
     * 9. Category Controls (Level 9: blocks categories configured with BLOCK)
     * 10. Default Fallback (Level 10: applies SafeSearch rewrite if configured; otherwise DEFAULT_ALLOW)
     */
    fun evaluate(
        targetDomain: String,
        currentTime: Date = Date(),
        simulatedUsageSeconds: Int = 0
    ): PolicyDecision {
        val policy = getPolicy() ?: return PolicyDecision("ALLOW", "DEFAULT_ALLOW")
        val norm = normalizeDomain(targetDomain)
        val now = currentTime
        val detectedCategory = CategoryDatabase.categorizeDomain(norm)

        // 1. Level 1: Essential Allow List
        if (policy.essentialAllowList.isNotEmpty()) {
            val essentialMatch = policy.essentialAllowList.find { domainMatches(norm, it) }
            if (essentialMatch != null) {
                val rewriteIp = checkSafeSearchRewrite(norm, policy)
                return PolicyDecision("ALLOW", "ESSENTIAL_ALLOW", rewriteIp = rewriteIp, category = detectedCategory)
            }
        }

        // 2. Level 2: Internet Pause / Dinner Time
        if (policy.isPaused) {
            if (policy.pauseExpiresAt != null) {
                val expiry = parseIsoDate(policy.pauseExpiresAt)
                if (expiry != null && now.before(expiry)) {
                    return PolicyDecision("BLOCK", "PAUSED_INTERNET", policy.pauseExpiresAt, category = detectedCategory)
                }
            } else {
                return PolicyDecision("BLOCK", "PAUSED_INTERNET", category = detectedCategory)
            }
        }

        // 3. Level 3: Screen Time / Usage Budget Limits (Domain & Category)
        if (policy.usageBudgets.isNotEmpty()) {
            val matchingBudget = policy.usageBudgets.find { b ->
                if (!b.enabled) return@find false
                if (b.targetType == "DOMAIN" && domainMatches(norm, b.target)) return@find true
                if (b.targetType == "CATEGORY" && b.target.equals(detectedCategory, ignoreCase = true)) return@find true
                false
            }
            if (matchingBudget != null && matchingBudget.unlimitedToday != true) {
                val totalAllowedSeconds = matchingBudget.dailyLimitSeconds + (matchingBudget.bonusSeconds ?: 0)
                val consumed = if (simulatedUsageSeconds > 0) simulatedUsageSeconds else getConsumedUsageSeconds(matchingBudget.target, matchingBudget.targetType)
                if (consumed >= totalAllowedSeconds) {
                    return PolicyDecision("BLOCK", "USAGE_LIMIT_EXHAUSTED", category = detectedCategory)
                }
            }
        }

        // 4. Level 4: Active Temporary Parental Grants
        val tempRule = policy.rules.find { r ->
            r.action == "TEMPORARY_ALLOW" && domainMatches(norm, r.domain) && r.expiresAt != null
        }
        if (tempRule != null) {
            val expiry = parseIsoDate(tempRule.expiresAt!!)
            if (expiry != null && now.before(expiry)) {
                val rewriteIp = checkSafeSearchRewrite(norm, policy)
                return PolicyDecision("ALLOW", "TEMPORARY_ALLOW", tempRule.expiresAt, rewriteIp = rewriteIp, category = detectedCategory)
            }
        }

        // 5. Level 5: Explicit Whitelist
        val allowRule = policy.rules.find { it.action == "ALLOW" && domainMatches(norm, it.domain) }
        if (allowRule != null) {
            val rewriteIp = checkSafeSearchRewrite(norm, policy)
            return PolicyDecision("ALLOW", "EXPLICIT_ALLOW", rewriteIp = rewriteIp, category = detectedCategory)
        }

        // 6. Level 6: Explicit Blacklist
        val blockRule = policy.rules.find { it.action == "BLOCK" && domainMatches(norm, it.domain) }
        if (blockRule != null) {
            return PolicyDecision("BLOCK", "EXPLICIT_BLOCK", category = detectedCategory)
        }

        // 7. Level 7: Study Mode
        val study = policy.studyMode
        if (study != null && study.active) {
            var active = true
            if (study.expiresAt != null) {
                val expiry = parseIsoDate(study.expiresAt)
                if (expiry != null && !now.before(expiry)) {
                    active = false
                }
            }
            if (active) {
                val isEducational = detectedCategory == "EDUCATION" ||
                        study.allowedCategories.any { it.equals(detectedCategory, ignoreCase = true) }
                if (!isEducational) {
                    return PolicyDecision("BLOCK", "STUDY_MODE_ACTIVE", category = detectedCategory)
                }
            }
        }

        // 8. Level 8: Bedtime Curfew
        val bedtime = policy.bedtime
        if (bedtime != null && bedtime.enabled) {
            if (isWithinBedtime(now, bedtime)) {
                val isEducational = detectedCategory == "EDUCATION"
                if (!bedtime.allowEducationalOnly || !isEducational) {
                    return PolicyDecision("BLOCK", "BEDTIME_ACTIVE", category = detectedCategory)
                }
            }
        }

        // 9. Level 9: Category Controls
        if (policy.categoryControls.isNotEmpty() && detectedCategory != null) {
            val catControl = policy.categoryControls.find { it.category.equals(detectedCategory, ignoreCase = true) }
            if (catControl != null && catControl.action == "BLOCK") {
                return PolicyDecision("BLOCK", "CATEGORY_BLOCKED", category = detectedCategory)
            }
        }

        // 10. Level 10: Default Fallback with SafeSearch VIP rewrite
        val rewriteIp = checkSafeSearchRewrite(norm, policy)
        if (rewriteIp != null) {
            return PolicyDecision("ALLOW", "SAFESEARCH_REWRITE", rewriteIp = rewriteIp, category = detectedCategory)
        }

        return PolicyDecision("ALLOW", "DEFAULT_ALLOW", category = detectedCategory)
    }
}
