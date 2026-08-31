package com.safebrowse.child.ui

import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.safebrowse.child.policy.LocalPolicyManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

class BlockScreenActivity : AppCompatActivity() {

    private val httpClient = OkHttpClient()
    private val scope = CoroutineScope(Dispatchers.Main)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val domain = intent.getStringExtra("EXTRA_BLOCKED_DOMAIN") ?: "This website"

        // Build child-friendly block UI programmatically
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(64, 96, 64, 64)
            setBackgroundColor(0xFF0F172A.toInt()) // Dark slate
        }

        val badge = TextView(this).apply {
            text = "SAFEBROWSE PROTECTION"
            textSize = 12f
            setTextColor(0xFFF87171.toInt()) // Red-400
            letterSpacing = 0.1f
            textAlignment = View.TEXT_ALIGNMENT_CENTER
        }
        layout.addView(badge)

        val title = TextView(this).apply {
            text = "$domain is restricted"
            textSize = 22f
            setTextColor(0xFFFFFFFF.toInt())
            setPadding(0, 24, 0, 16)
            textAlignment = View.TEXT_ALIGNMENT_CENTER
        }
        layout.addView(title)

        val desc = TextView(this).apply {
            text = "This website is restricted by your family safety settings."
            textSize = 14f
            setTextColor(0xFF94A3B8.toInt())
            setPadding(0, 0, 0, 48)
            textAlignment = View.TEXT_ALIGNMENT_CENTER
        }
        layout.addView(desc)

        val reasonInput = EditText(this).apply {
            hint = "Why do you need this website? (e.g. For biology project)"
            setHintTextColor(0xFF64748B.toInt())
            setTextColor(0xFFFFFFFF.toInt())
            setBackgroundColor(0xFF1E293B.toInt())
            setPadding(32, 32, 32, 32)
            visibility = View.GONE
        }
        layout.addView(reasonInput)

        val askBtn = Button(this).apply {
            text = "Ask Parent for Access"
            setBackgroundColor(0xFF16A34A.toInt()) // Emerald
            setTextColor(0xFFFFFFFF.toInt())
            setOnClickListener {
                if (reasonInput.visibility == View.GONE) {
                    reasonInput.visibility = View.VISIBLE
                    text = "Send Request to Parent"
                } else {
                    val reason = reasonInput.text.toString().trim()
                    submitAskRequest(domain, reason, this)
                }
            }
        }
        layout.addView(askBtn)

        setContentView(layout)
    }

    private fun submitAskRequest(domain: String, reason: String, btn: Button) {
        btn.isEnabled = false
        btn.text = "Sending..."

        val prefs = getSharedPreferences("safebrowse_device", MODE_PRIVATE)
        val childId = prefs.getString("child_id", "") ?: ""
        val deviceId = prefs.getString("device_id", "") ?: ""
        val backendUrl = prefs.getString("backend_url", "http://10.0.2.2:4000") ?: ""

        val json = JSONObject().apply {
            put("childId", childId)
            put("deviceId", deviceId)
            put("domain", domain)
            put("reason", reason)
        }

        scope.launch {
            val success = withContext(Dispatchers.IO) {
                try {
                    val body = json.toString().toRequestBody("application/json".toMediaType())
                    val request = Request.Builder()
                        .url("$backendUrl/api/requests")
                        .post(body)
                        .build()
                    val response = httpClient.newCall(request).execute()
                    response.isSuccessful
                } catch (e: Exception) {
                    false
                }
            }

            if (success) {
                Toast.makeText(this@BlockScreenActivity, "Request sent to parent!", Toast.LENGTH_LONG).show()
                finish()
            } else {
                Toast.makeText(this@BlockScreenActivity, "Could not send request.", Toast.LENGTH_SHORT).show()
                btn.isEnabled = true
                btn.text = "Try Again"
            }
        }
    }
}
