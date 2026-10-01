package com.safebrowse.child.usage

import android.app.AppOpsManager
import android.content.Context
import android.os.Build
import android.os.Process
import android.util.Log
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import com.safebrowse.child.config.AgentConfig
import com.safebrowse.child.policy.LocalPolicyManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Collections
import java.util.Date
import java.util.Locale
import java.util.TimeZone

data class PendingUsageDelta(
    val target: String,
    val targetType: String, // "DOMAIN", "CATEGORY", "APP"
    val secondsIncrement: Int,
    val clientWallIso: String
)

class UsageTracker private constructor(private val context: Context) {

    private val gson = Gson()
    private val httpClient = OkHttpClient()
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val pendingDeltas = Collections.synchronizedList(mutableListOf<PendingUsageDelta>())
    private val deltaFile = File(context.filesDir, "usage_deltas.json")
    private val activeDomains = Collections.synchronizedMap(mutableMapOf<String, Long>())
    private val activeCategories = Collections.synchronizedMap(mutableMapOf<String, Long>())
    private var isSyncing = false
    private var isRunning = false

    // Testing hook
    private var customSyncSender: ((PendingUsageDelta) -> Boolean)? = null

    init {
        loadPendingDeltas()
    }

    companion object {
        private const val TAG = "UsageTracker"
        private const val SYNC_INTERVAL_MS = 30_000L
        private const val DOMAIN_ACTIVE_TTL_MS = 30_000L

        @Volatile
        private var instance: UsageTracker? = null

        fun getInstance(context: Context): UsageTracker {
            return instance ?: synchronized(this) {
                instance ?: UsageTracker(context.applicationContext).also {
                    instance = it
                }
            }
        }

        /**
         * Detects whether the device has granted PACKAGE_USAGE_STATS capability via AppOps.
         */
        fun hasUsageStatsPermission(context: Context): Boolean {
            val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as? AppOpsManager ?: return false
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                appOps.unsafeCheckOpNoThrow(
                    AppOpsManager.OPSTR_GET_USAGE_STATS,
                    Process.myUid(),
                    context.packageName
                )
            } else {
                @Suppress("DEPRECATION")
                appOps.checkOpNoThrow(
                    AppOpsManager.OPSTR_GET_USAGE_STATS,
                    Process.myUid(),
                    context.packageName
                )
            }
            return mode == AppOpsManager.MODE_ALLOWED
        }
    }

    fun setCustomSyncSenderForTesting(sender: ((PendingUsageDelta) -> Boolean)?) {
        this.customSyncSender = sender
    }

    fun getPendingDeltaCount(): Int = pendingDeltas.size

    private fun loadPendingDeltas() {
        try {
            if (deltaFile.exists()) {
                val json = deltaFile.readText()
                val type = object : TypeToken<List<PendingUsageDelta>>() {}.type
                val saved: List<PendingUsageDelta>? = gson.fromJson(json, type)
                if (!saved.isNullOrEmpty()) {
                    synchronized(pendingDeltas) {
                        pendingDeltas.clear()
                        pendingDeltas.addAll(saved)
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to load usage deltas: ${e.message}")
        }
    }

    private fun savePendingDeltas() {
        try {
            val copy = synchronized(pendingDeltas) { pendingDeltas.toList() }
            deltaFile.writeText(gson.toJson(copy))
        } catch (e: Exception) {
            Log.w(TAG, "Failed to save usage deltas: ${e.message}")
        }
    }

    private fun formatCurrentIsoUtc(): String {
        val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        sdf.timeZone = TimeZone.getTimeZone("UTC")
        return sdf.format(Date())
    }

    /**
     * Records access for an allowed domain and its category.
     * Called by SafeBrowseVpnService upon allowed DNS resolution.
     */
    fun recordDomainAccess(domain: String, category: String? = null) {
        val now = System.currentTimeMillis()
        val lowerDomain = domain.trim().lowercase(Locale.ROOT)
        activeDomains[lowerDomain] = now
        if (!category.isNullOrBlank()) {
            activeCategories[category.trim().uppercase(Locale.ROOT)] = now
        }
    }

    fun start() {
        if (isRunning) return
        isRunning = true
        scope.launch {
            while (isRunning) {
                delay(SYNC_INTERVAL_MS)
                tickAndSync()
            }
        }
    }

    fun stop() {
        isRunning = false
        savePendingDeltas()
    }

    /**
     * Converts active domain/category activity into concrete 30s increments,
     * enqueues deltas, and synchronizes to backend.
     */
    suspend fun tickAndSync() {
        val now = System.currentTimeMillis()
        val policyManager = LocalPolicyManager(context)
        val iso = formatCurrentIsoUtc()

        // 1. Snapshot active domains within active window
        val domainKeys = synchronized(activeDomains) {
            val keys = mutableListOf<String>()
            val iter = activeDomains.entries.iterator()
            while (iter.hasNext()) {
                val entry = iter.next()
                if (now - entry.value <= DOMAIN_ACTIVE_TTL_MS) {
                    keys.add(entry.key)
                }
                iter.remove()
            }
            keys
        }

        for (domain in domainKeys) {
            val delta = PendingUsageDelta(domain, "DOMAIN", 30, iso)
            synchronized(pendingDeltas) { pendingDeltas.add(delta) }
            policyManager.recordLocalUsage(domain, "DOMAIN", 30)
        }

        // 2. Snapshot active categories within active window
        val catKeys = synchronized(activeCategories) {
            val keys = mutableListOf<String>()
            val iter = activeCategories.entries.iterator()
            while (iter.hasNext()) {
                val entry = iter.next()
                if (now - entry.value <= DOMAIN_ACTIVE_TTL_MS) {
                    keys.add(entry.key)
                }
                iter.remove()
            }
            keys
        }

        for (cat in catKeys) {
            val delta = PendingUsageDelta(cat, "CATEGORY", 30, iso)
            synchronized(pendingDeltas) { pendingDeltas.add(delta) }
            policyManager.recordLocalUsage(cat, "CATEGORY", 30)
        }

        savePendingDeltas()
        flushDeltas()
    }

    suspend fun flushDeltas() {
        if (isSyncing || pendingDeltas.isEmpty()) return
        isSyncing = true

        try {
            val snapshot = synchronized(pendingDeltas) { pendingDeltas.toList() }
            if (snapshot.isEmpty()) {
                isSyncing = false
                return
            }

            val prefs = context.getSharedPreferences("safebrowse_device", Context.MODE_PRIVATE)
            val deviceId = prefs.getString("device_id", null)
            val deviceToken = prefs.getString("device_token", null)
            val childId = prefs.getString("child_id", null) ?: ""
            val backendUrl = AgentConfig.getBackendUrl(context)

            if (deviceId.isNullOrBlank() || deviceToken.isNullOrBlank()) {
                isSyncing = false
                return
            }

            for (delta in snapshot) {
                if (customSyncSender != null) {
                    val ok = customSyncSender!!.invoke(delta)
                    if (ok) {
                        synchronized(pendingDeltas) { pendingDeltas.remove(delta) }
                        savePendingDeltas()
                    }
                    continue
                }

                val payload = JSONObject().apply {
                    put("childId", childId)
                    put("deviceId", deviceId)
                    put("target", delta.target)
                    put("targetType", delta.targetType)
                    put("secondsIncrement", delta.secondsIncrement)
                    put("clientWallIso", delta.clientWallIso)
                }

                val body = payload.toString().toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url("$backendUrl/api/usage/sync")
                    .addHeader("x-device-id", deviceId)
                    .addHeader("x-device-token", deviceToken)
                    .post(body)
                    .build()

                try {
                    val response = httpClient.newCall(request).execute()
                    if (response.isSuccessful) {
                        synchronized(pendingDeltas) { pendingDeltas.remove(delta) }
                        savePendingDeltas()
                    } else {
                        Log.w(TAG, "Usage sync rejected for ${delta.target}: HTTP ${response.code}. Retaining unsent delta.")
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Usage sync network failure for ${delta.target}: ${e.message}")
                    break // Stop iterating on network disconnect
                }
            }
        } finally {
            isSyncing = false
        }
    }
}
