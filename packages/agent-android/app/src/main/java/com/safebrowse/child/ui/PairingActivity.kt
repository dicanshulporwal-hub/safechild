package com.safebrowse.child.ui

import android.content.Intent
import android.net.VpnService
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.safebrowse.child.policy.LocalPolicyManager
import com.safebrowse.child.policy.Policy
import com.safebrowse.child.vpn.SafeBrowseVpnService
import com.google.gson.Gson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

class PairingActivity : AppCompatActivity() {

    private val httpClient = OkHttpClient()
    private val scope = CoroutineScope(Dispatchers.Main)
    private val VPN_REQUEST_CODE = 1001

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val prefs = getSharedPreferences("safebrowse_device", MODE_PRIVATE)
        val deviceToken = prefs.getString("device_token", null)

        if (deviceToken != null) {
            // Already paired -> start VPN directly
            requestVpnPermissionAndStart()
            return
        }

        // Render Pairing Screen
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(64, 120, 64, 64)
            setBackgroundColor(0xFF0F172A.toInt())
        }

        val title = TextView(this).apply {
            text = "SafeBrowse Child Setup"
            textSize = 24f
            setTextColor(0xFFFFFFFF.toInt())
            setPadding(0, 0, 0, 16)
        }
        layout.addView(title)

        val desc = TextView(this).apply {
            text = "Enter the 6-digit pairing code shown on your parent's dashboard."
            textSize = 14f
            setTextColor(0xFF94A3B8.toInt())
            setPadding(0, 0, 0, 48)
        }
        layout.addView(desc)

        val codeInput = EditText(this).apply {
            hint = "e.g. SB-8921"
            setHintTextColor(0xFF64748B.toInt())
            setTextColor(0xFFFFFFFF.toInt())
            setBackgroundColor(0xFF1E293B.toInt())
            setPadding(32, 32, 32, 32)
        }
        layout.addView(codeInput)

        val pairBtn = Button(this).apply {
            text = "Pair This Device"
            setBackgroundColor(0xFF16A34A.toInt())
            setTextColor(0xFFFFFFFF.toInt())
            setOnClickListener {
                val code = codeInput.text.toString().trim().uppercase()
                if (code.isNotEmpty()) {
                    performPairing(code, this)
                }
            }
        }
        layout.addView(pairBtn)

        setContentView(layout)
    }

    private fun performPairing(code: String, btn: Button) {
        btn.isEnabled = false
        btn.text = "Pairing..."

        val backendUrl = "http://10.0.2.2:4000" // Standard Android emulator loopback to host

        val json = JSONObject().apply {
            put("code", code)
            put("deviceName", "Rahul's Android Phone")
            put("platform", "android")
            put("agentVersion", "1.0.0")
        }

        scope.launch {
            val result = withContext(Dispatchers.IO) {
                try {
                    val body = json.toString().toRequestBody("application/json".toMediaType())
                    val request = Request.Builder()
                        .url("$backendUrl/api/devices/claim")
                        .post(body)
                        .build()
                    val response = httpClient.newCall(request).execute()
                    if (response.isSuccessful) {
                        response.body?.string()
                    } else {
                        null
                    }
                } catch (e: Exception) {
                    null
                }
            }

            if (result != null) {
                val obj = JSONObject(result)
                val device = obj.getJSONObject("device")
                val policyJson = obj.optJSONObject("policy")

                val prefs = getSharedPreferences("safebrowse_device", MODE_PRIVATE)
                prefs.edit()
                    .putString("device_id", device.getString("id"))
                    .putString("device_token", device.getString("deviceToken"))
                    .putString("child_id", device.getString("childId"))
                    .putString("backend_url", backendUrl)
                    .apply()

                if (policyJson != null) {
                    val policyManager = LocalPolicyManager(this@PairingActivity)
                    val policy = Gson().fromJson(policyJson.toString(), Policy::class.java)
                    policyManager.savePolicy(policy)
                }

                Toast.makeText(this@PairingActivity, "Successfully paired!", Toast.LENGTH_SHORT).show()
                requestVpnPermissionAndStart()
            } else {
                Toast.makeText(this@PairingActivity, "Pairing failed. Check code.", Toast.LENGTH_SHORT).show()
                btn.isEnabled = true
                btn.text = "Try Again"
            }
        }
    }

    private fun requestVpnPermissionAndStart() {
        val vpnIntent = VpnService.prepare(this)
        if (vpnIntent != null) {
            startActivityForResult(vpnIntent, VPN_REQUEST_CODE)
        } else {
            onActivityResult(VPN_REQUEST_CODE, RESULT_OK, null)
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == VPN_REQUEST_CODE && resultCode == RESULT_OK) {
            val serviceIntent = Intent(this, SafeBrowseVpnService::class.java)
            startService(serviceIntent)
            Toast.makeText(this, "SafeBrowse Protection Active", Toast.LENGTH_LONG).show()
            finish()
        }
    }
}
