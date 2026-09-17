package com.safebrowse.child.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.safebrowse.child.policy.LocalPolicyManager
import com.safebrowse.child.policy.Policy
import com.safebrowse.child.vpn.SafeBrowseVpnService
import com.google.gson.Gson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

class SyncWorker(appContext: Context, workerParams: WorkerParameters) :
    CoroutineWorker(appContext, workerParams) {

    private val httpClient = OkHttpClient()

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val prefs = applicationContext.getSharedPreferences("safebrowse_device", Context.MODE_PRIVATE)
        val deviceId = prefs.getString("device_id", null) ?: return@withContext Result.failure()
        val deviceToken = prefs.getString("device_token", null) ?: return@withContext Result.failure()
        val backendUrl = com.safebrowse.child.config.AgentConfig.getBackendUrl(applicationContext)

        val policyManager = LocalPolicyManager(applicationContext)
        val activeVersion = policyManager.getPolicy()?.version ?: 1

        val heartbeatJson = JSONObject().apply {
            put("deviceId", deviceId)
            put("deviceToken", deviceToken)
            put("activePolicyVersion", activeVersion)
            put("enforcementActive", true)
            put("platform", "android")
            put("agentVersion", "1.0.0")
        }

        try {
            val body = heartbeatJson.toString().toRequestBody("application/json".toMediaType())
            val request = Request.Builder()
                .url("$backendUrl/api/devices/heartbeat")
                .post(body)
                .build()

            val response = httpClient.newCall(request).execute()
            if (response.isSuccessful) {
                val resObj = JSONObject(response.body?.string() ?: "{}")
                if (resObj.optBoolean("policyChanged", false)) {
                    // Fetch updated policy
                    val policyReq = Request.Builder()
                        .url("$backendUrl/api/policies/device/$deviceId")
                        .get()
                        .build()
                    val policyRes = httpClient.newCall(policyReq).execute()
                    if (policyRes.isSuccessful) {
                        val pData = JSONObject(policyRes.body?.string() ?: "{}")
                        val updatedPolicy = Gson().fromJson(
                            pData.getJSONObject("policy").toString(),
                            Policy::class.java
                        )
                        policyManager.savePolicy(updatedPolicy)
                    }
                }
                Result.success()
            } else {
                Result.retry()
            }
        } catch (e: Exception) {
            Result.retry()
        }
    }
}

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            val serviceIntent = Intent(context, SafeBrowseVpnService::class.java)
            context.startService(serviceIntent)
        }
    }
}
