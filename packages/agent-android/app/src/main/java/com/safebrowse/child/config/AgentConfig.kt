package com.safebrowse.child.config

import android.content.Context
import com.safebrowse.child.BuildConfig
import java.net.URI

/**
 * Centralized agent configuration provider.
 * Manages build-time API base URL resolution, validation, and persistent storage.
 */
object AgentConfig {

    /**
     * Build-time configured default API base URL.
     * Evaluated once and cached. Throws IllegalArgumentException if malformed.
     */
    val apiBaseUrl: String by lazy {
        validateApiBaseUrl(BuildConfig.SAFEBROWSE_API_BASE_URL)
    }

    /**
     * Validates an API base URL string.
     * Enforces:
     * - Non-blank
     * - Valid URI syntax
     * - http or https protocol only
     * - Hostname present
     * - Stripped trailing slash
     * - Production: strict HTTPS (cleartext prohibited)
     * - Debug: HTTP permitted only for approved targets (10.0.2.2, localhost/127.0.0.1/[::1], or Tailscale CGNAT 100.64.0.0/10)
     */
    fun validateApiBaseUrl(rawUrl: String?, isDebug: Boolean = BuildConfig.DEBUG): String {
        val trimmed = rawUrl?.trim()?.trimEnd('/') ?: ""
        require(trimmed.isNotBlank()) {
            "SAFEBROWSE_API_BASE_URL must not be blank."
        }

        val uri = try {
            URI(trimmed)
        } catch (e: Exception) {
            throw IllegalArgumentException("Invalid SAFEBROWSE_API_BASE_URL format: '$rawUrl'", e)
        }

        val scheme = uri.scheme?.lowercase()
        require(scheme == "http" || scheme == "https") {
            "SAFEBROWSE_API_BASE_URL must use http or https scheme, got: '$scheme'"
        }

        val host = uri.host
        require(!host.isNullOrBlank()) {
            "SAFEBROWSE_API_BASE_URL must specify a valid host, got: '$rawUrl'"
        }

        if (scheme == "http") {
            require(isDebug) {
                "Cleartext HTTP is strictly prohibited in production builds. HTTPS is required."
            }
            require(isApprovedDebugHost(host)) {
                "Cleartext HTTP is only permitted for approved local/mesh targets (10.0.2.2, localhost/127.0.0.1, or Tailscale CGNAT 100.64.0.0/10), got host: '$host'"
            }
        }

        return trimmed
    }

    /**
     * Checks if a host is an approved development or private mesh endpoint.
     */
    fun isApprovedDebugHost(host: String): Boolean {
        val cleanHost = host.lowercase().trim('[', ']')
        if (cleanHost == "localhost" || cleanHost == "127.0.0.1" || cleanHost == "::1") return true
        if (cleanHost == "10.0.2.2") return true
        if (isTailscaleCgnatIp(cleanHost)) return true
        return false
    }

    /**
     * Validates if an IP address belongs to the Tailscale CGNAT range (100.64.0.0/10).
     * The /10 range covers 100.64.0.0 through 100.127.255.255.
     */
    fun isTailscaleCgnatIp(host: String): Boolean {
        val parts = host.split(".")
        if (parts.size != 4) return false
        val o1 = parts[0].toIntOrNull() ?: return false
        val o2 = parts[1].toIntOrNull() ?: return false
        val o3 = parts[2].toIntOrNull() ?: return false
        val o4 = parts[3].toIntOrNull() ?: return false
        if (o1 != 100) return false
        if (o2 !in 64..127) return false
        if (o3 !in 0..255 || o4 !in 0..255) return false
        return true
    }

    /**
     * Returns the active backend URL for API communications.
     * Checks SharedPreferences first; if absent or invalid, falls back to the build-time SAFEBROWSE_API_BASE_URL.
     */
    fun getBackendUrl(context: Context): String {
        val prefs = context.getSharedPreferences("safebrowse_device", Context.MODE_PRIVATE)
        val persisted = prefs.getString("backend_url", null)
        if (!persisted.isNullOrBlank()) {
            try {
                return validateApiBaseUrl(persisted, BuildConfig.DEBUG)
            } catch (e: Exception) {
                // Persisted URL was corrupted or violated security rules; fall through to build-time default
            }
        }
        return apiBaseUrl
    }

    /**
     * Persists the validated backend URL into device preferences upon successful pairing.
     */
    fun setBackendUrl(context: Context, url: String) {
        val validated = validateApiBaseUrl(url, BuildConfig.DEBUG)
        val prefs = context.getSharedPreferences("safebrowse_device", Context.MODE_PRIVATE)
        prefs.edit().putString("backend_url", validated).apply()
    }
}
