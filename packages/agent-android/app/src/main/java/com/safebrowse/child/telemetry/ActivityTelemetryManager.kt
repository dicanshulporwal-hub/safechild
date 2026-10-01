package com.safebrowse.child.telemetry

import android.content.Context
import android.util.Log
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import com.safebrowse.child.config.AgentConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Collections
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

data class ActivityRecord(
    val id: String,
    val domain: String,
    val action: String, // "BLOCKED", "ALLOWED", "TEMPORARY_ACCESSED"
    val childId: String,
    val deviceId: String,
    val category: String? = null,
    val reason: String? = null,
    val timestamp: String // ISO-8601 UTC
)

class ActivityTelemetryManager private constructor(private val context: Context) {

    private val gson = Gson()
    private val httpClient = OkHttpClient()
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val outbox = Collections.synchronizedList(mutableListOf<ActivityRecord>())
    private val outboxFile: File = File(context.filesDir, "activity_outbox.json")
    private var isFlushing = false
    private var isRunning = false

    // Testing hook for custom transport
    private var customSender: ((List<ActivityRecord>) -> Boolean)? = null

    init {
        loadOutbox()
    }

    companion object {
        private const val TAG = "ActivityTelemetry"
        private const val MAX_OUTBOX_SIZE = 500
        private const val BATCH_SIZE = 50
        private const val FLUSH_INTERVAL_MS = 30_000L

        @Volatile
        private var instance: ActivityTelemetryManager? = null

        fun getInstance(context: Context): ActivityTelemetryManager {
            return instance ?: synchronized(this) {
                instance ?: ActivityTelemetryManager(context.applicationContext).also {
                    instance = it
                }
            }
        }
    }

    fun setCustomSenderForTesting(sender: ((List<ActivityRecord>) -> Boolean)?) {
        this.customSender = sender
    }

    fun getOutboxCount(): Int = outbox.size

    private fun loadOutbox() {
        try {
            if (outboxFile.exists()) {
                val json = outboxFile.readText()
                val type = object : TypeToken<List<ActivityRecord>>() {}.type
                val saved: List<ActivityRecord>? = gson.fromJson(json, type)
                if (!saved.isNullOrEmpty()) {
                    synchronized(outbox) {
                        outbox.clear()
                        outbox.addAll(saved.takeLast(MAX_OUTBOX_SIZE))
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to load activity outbox: ${e.message}")
        }
    }

    private fun saveOutbox() {
        try {
            val listCopy = synchronized(outbox) { outbox.toList() }
            outboxFile.writeText(gson.toJson(listCopy))
        } catch (e: Exception) {
            Log.w(TAG, "Failed to save activity outbox: ${e.message}")
        }
    }

    private fun formatCurrentIsoUtc(): String {
        val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        sdf.timeZone = TimeZone.getTimeZone("UTC")
        return sdf.format(Date())
    }

    /**
     * Enqueue a DNS activity record non-blockingly.
     * Guaranteed never to stall DNS packet forwarding loop.
     */
    fun recordEvent(
        domain: String,
        action: String,
        category: String? = null,
        reason: String? = null,
        eventTimestamp: String? = null
    ) {
        val prefs = context.getSharedPreferences("safebrowse_device", Context.MODE_PRIVATE)
        val deviceId = prefs.getString("device_id", null) ?: return
        val childId = prefs.getString("child_id", null) ?: ""

        val normalizedAction = when (action.uppercase(Locale.ROOT)) {
            "BLOCK", "BLOCKED" -> "BLOCKED"
            "ALLOW", "ALLOWED" -> "ALLOWED"
            "TEMPORARY_ACCESSED", "TEMPORARY_ALLOW" -> "TEMPORARY_ACCESSED"
            else -> "ALLOWED"
        }

        val record = ActivityRecord(
            id = "act_${UUID.randomUUID()}",
            domain = domain,
            action = normalizedAction,
            childId = childId,
            deviceId = deviceId,
            category = category,
            reason = reason,
            timestamp = eventTimestamp ?: formatCurrentIsoUtc()
        )

        scope.launch {
            synchronized(outbox) {
                outbox.add(record)
                if (outbox.size > MAX_OUTBOX_SIZE) {
                    outbox.removeAt(0) // Drop oldest to bound memory
                }
            }
            saveOutbox()

            if (outbox.size >= 20) {
                flush()
            }
        }
    }

    fun start() {
        if (isRunning) return
        isRunning = true
        scope.launch {
            while (isRunning) {
                delay(FLUSH_INTERVAL_MS)
                flush()
            }
        }
    }

    fun stop() {
        isRunning = false
        saveOutbox()
    }

    /**
     * Uploads queued events to POST /api/activity in batches.
     * Retains failed batches for retry on transient network failures.
     */
    suspend fun flush() {
        if (isFlushing || outbox.isEmpty()) return
        isFlushing = true

        try {
            val batch = synchronized(outbox) {
                outbox.take(BATCH_SIZE)
            }
            if (batch.isEmpty()) {
                isFlushing = false
                return
            }

            if (customSender != null) {
                val ok = customSender!!.invoke(batch)
                if (ok) {
                    synchronized(outbox) {
                        outbox.removeAll(batch.toSet())
                    }
                    saveOutbox()
                }
                isFlushing = false
                return
            }

            val prefs = context.getSharedPreferences("safebrowse_device", Context.MODE_PRIVATE)
            val deviceId = prefs.getString("device_id", null)
            val deviceToken = prefs.getString("device_token", null)
            val backendUrl = AgentConfig.getBackendUrl(context)

            if (deviceId.isNullOrBlank() || deviceToken.isNullOrBlank()) {
                isFlushing = false
                return
            }

            val eventsJsonArray = JSONArray()
            for (ev in batch) {
                eventsJsonArray.put(JSONObject().apply {
                    put("domain", ev.domain)
                    put("action", ev.action)
                    put("childId", ev.childId)
                    put("deviceId", ev.deviceId)
                    ev.category?.let { put("category", it) }
                    ev.reason?.let { put("reason", it) }
                    put("timestamp", ev.timestamp)
                })
            }

            val payload = JSONObject().apply {
                put("events", eventsJsonArray)
            }

            val body = payload.toString().toRequestBody("application/json".toMediaType())
            val request = Request.Builder()
                .url("$backendUrl/api/activity")
                .addHeader("x-device-id", deviceId)
                .addHeader("x-device-token", deviceToken)
                .post(body)
                .build()

            val response = httpClient.newCall(request).execute()
            if (response.isSuccessful) {
                synchronized(outbox) {
                    outbox.removeAll(batch.toSet())
                }
                saveOutbox()
                Log.d(TAG, "Flushed ${batch.size} activity events to backend.")
            } else {
                Log.w(TAG, "Activity telemetry sync rejected: HTTP ${response.code}. Will retry.")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Activity telemetry flush deferred: ${e.message}")
        } finally {
            isFlushing = false
        }
    }
}
