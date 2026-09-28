package com.safebrowse.child.ui

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.gson.Gson
import com.safebrowse.child.BuildConfig
import com.safebrowse.child.config.AgentConfig
import com.safebrowse.child.policy.LocalPolicyManager
import com.safebrowse.child.policy.Policy
import com.safebrowse.child.sync.SyncWorker
import com.safebrowse.child.vpn.SafeBrowseVpnService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * SafeBrowse Child Application Activity
 * Displays Device Enrollment screen when unpaired,
 * and the Minimal Child Status Screen when enrolled and protected.
 */
class PairingActivity : AppCompatActivity() {

    private val httpClient = OkHttpClient()
    private val scope = CoroutineScope(Dispatchers.Main)
    private val VPN_REQUEST_CODE = 1001

    private lateinit var policyManager: LocalPolicyManager

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        policyManager = LocalPolicyManager(this)

        if (policyManager.isPaired()) {
            SyncWorker.schedulePeriodicSync(this)
            checkAndStartVpn()
            renderStatusScreen()
        } else {
            renderPairingScreen()
        }
    }

    override fun onResume() {
        super.onResume()
        if (policyManager.isPaired()) {
            renderStatusScreen()
        }
    }

    // =========================================================================
    // MINIMAL CHILD UI (ENROLLED & PROTECTED STATUS)
    // =========================================================================

    private fun renderStatusScreen() {
        val prefs = getSharedPreferences("safebrowse_device", Context.MODE_PRIVATE)
        val childName = prefs.getString("child_name", "Rahul") ?: "Rahul"
        val deviceName = prefs.getString("device_name", "Android Phone") ?: "Android Phone"
        val lastSync = prefs.getString("last_sync", "Active") ?: "Active"

        val isVpnActive = SafeBrowseVpnService.isServiceRunning
        val policy = policyManager.getPolicy()

        val screenTimeRemaining: String = when {
            policy?.isPaused == true -> "Paused by Parent"
            policy?.usageBudgets.isNullOrEmpty() -> "Managed by Parent"
            policy?.usageBudgets?.any { it.unlimitedToday == true } == true -> "Unlimited Today"
            else -> {
                val budget = policy?.usageBudgets?.firstOrNull { it.enabled }
                if (budget != null) {
                    val totalSec = budget.dailyLimitSeconds + (budget.bonusSeconds ?: 0)
                    "${totalSec / 60} min quota"
                } else {
                    "Managed by Family Policy"
                }
            }
        }

        val scroll = ScrollView(this).apply {
            setBackgroundColor(Color.parseColor("#0F172A")) // Dark Slate 900
            isFillViewport = true
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 80, 48, 48)
            gravity = Gravity.CENTER_HORIZONTAL
        }

        // Header Title
        val header = TextView(this).apply {
            text = "SafeBrowse"
            textSize = 28f
            setTextColor(Color.WHITE)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, 8)
        }
        root.addView(header)

        val subheader = TextView(this).apply {
            text = "Child Device Protection"
            textSize = 14f
            setTextColor(Color.parseColor("#94A3B8")) // Slate 400
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, 48)
        }
        root.addView(subheader)

        // Status Card
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(40, 40, 40, 40)
            setBackgroundColor(Color.parseColor("#1E293B")) // Slate 800
            val layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                bottomMargin = 48
            }
            this.layoutParams = layoutParams
        }

        // Item 1: Protection Status
        addStatusRow(card, "PROTECTION", if (isVpnActive) "Active" else "Inactive", if (isVpnActive) "#22C55E" else "#F59E0B")

        // If inactive, show Activate Protection button
        if (!isVpnActive) {
            val activateBtn = Button(this).apply {
                text = "Activate Protection"
                setBackgroundColor(Color.parseColor("#2563EB"))
                setTextColor(Color.WHITE)
                textSize = 14f
                setOnClickListener {
                    requestVpnPermissionAndStart()
                }
                val params = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply {
                    topMargin = 16
                    bottomMargin = 24
                }
                layoutParams = params
            }
            card.addView(activateBtn)
        }

        // Item 2: Child Name
        addStatusRow(card, "CHILD", childName, "#F8FAFC")

        // Item 3: Device Name
        addStatusRow(card, "DEVICE", deviceName, "#F8FAFC")

        // Item 4: Screen Time Remaining
        addStatusRow(card, "SCREEN TIME REMAINING", screenTimeRemaining, "#38BDF8") // Sky 400

        // Item 5: Last Policy Sync
        val policyVersionStr = if (policy != null) " (v${policy.version})" else ""
        addStatusRow(card, "LAST POLICY SYNC", "$lastSync$policyVersionStr", "#94A3B8")

        root.addView(card)

        // Action Button: Ask Parent
        val askParentBtn = Button(this).apply {
            text = "Ask Parent"
            setBackgroundColor(Color.parseColor("#16A34A")) // Emerald 600
            setTextColor(Color.WHITE)
            textSize = 16f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(32, 24, 32, 24)
            setOnClickListener {
                val intent = Intent(this@PairingActivity, BlockScreenActivity::class.java).apply {
                    putExtra("EXTRA_BLOCKED_DOMAIN", "General Internet Access")
                }
                startActivity(intent)
            }
            val params = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                bottomMargin = 24
            }
            layoutParams = params
        }
        root.addView(askParentBtn)

        // Action Button: Sync Now
        val syncBtn = Button(this).apply {
            text = "Sync Policy"
            setBackgroundColor(Color.parseColor("#334155")) // Slate 700
            setTextColor(Color.parseColor("#E2E8F0"))
            textSize = 14f
            setPadding(32, 16, 32, 16)
            setOnClickListener {
                triggerManualSync(this)
            }
            val params = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            layoutParams = params
        }
        root.addView(syncBtn)

        scroll.removeAllViews()
        scroll.addView(root)
        setContentView(scroll)
    }

    private fun addStatusRow(container: LinearLayout, label: String, value: String, valueColorHex: String) {
        val labelView = TextView(this).apply {
            text = label
            textSize = 11f
            setTextColor(Color.parseColor("#64748B")) // Slate 500
            letterSpacing = 0.08f
            setPadding(0, 16, 0, 4)
        }
        container.addView(labelView)

        val valueView = TextView(this).apply {
            text = value
            textSize = 17f
            setTextColor(Color.parseColor(valueColorHex))
            typeface = Typeface.DEFAULT_BOLD
            setPadding(0, 0, 0, 8)
        }
        container.addView(valueView)
    }

    private fun triggerManualSync(btn: Button) {
        btn.isEnabled = false
        btn.text = "Syncing..."

        val prefs = getSharedPreferences("safebrowse_device", Context.MODE_PRIVATE)
        val deviceId = prefs.getString("device_id", "") ?: ""
        val deviceToken = prefs.getString("device_token", "") ?: ""
        val backendUrl = AgentConfig.getBackendUrl(this)

        scope.launch {
            val synced = withContext(Dispatchers.IO) {
                try {
                    val req = Request.Builder()
                        .url("$backendUrl/api/policies/device/$deviceId")
                        .header("x-device-id", deviceId)
                        .header("x-device-token", deviceToken)
                        .get()
                        .build()
                    val res = httpClient.newCall(req).execute()
                    if (res.isSuccessful) {
                        val body = res.body?.string() ?: "{}"
                        val obj = JSONObject(body)
                        val pObj = obj.optJSONObject("policy")
                        if (pObj != null) {
                            val updatedPolicy = Gson().fromJson(pObj.toString(), Policy::class.java)
                            policyManager.savePolicy(updatedPolicy)
                        }
                        val childObj = obj.optJSONObject("child")
                        val nowStr = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())
                        val editor = prefs.edit().putString("last_sync", nowStr)
                        if (childObj != null && childObj.has("name")) {
                            editor.putString("child_name", childObj.getString("name"))
                        }
                        editor.apply()
                        true
                    } else {
                        false
                    }
                } catch (e: Exception) {
                    false
                }
            }

            btn.isEnabled = true
            btn.text = "Sync Policy"
            if (synced) {
                Toast.makeText(this@PairingActivity, "Policy synchronized!", Toast.LENGTH_SHORT).show()
                renderStatusScreen()
            } else {
                Toast.makeText(this@PairingActivity, "Sync failed. Will retry automatically.", Toast.LENGTH_SHORT).show()
            }
        }
    }

    // =========================================================================
    // PAIRING / ENROLLMENT UI (UNENROLLED STATE)
    // =========================================================================

    private fun renderPairingScreen() {
        val scroll = ScrollView(this).apply {
            setBackgroundColor(Color.parseColor("#0F172A"))
            isFillViewport = true
        }

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(56, 100, 56, 56)
            gravity = Gravity.CENTER_HORIZONTAL
        }

        val title = TextView(this).apply {
            text = "SafeBrowse Setup"
            textSize = 26f
            setTextColor(Color.WHITE)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, 12)
        }
        layout.addView(title)

        val desc = TextView(this).apply {
            text = "Enter the 6-character pairing code shown on your parent's dashboard to enroll this device."
            textSize = 14f
            setTextColor(Color.parseColor("#94A3B8"))
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, 48)
        }
        layout.addView(desc)

        val codeInput = EditText(this).apply {
            hint = "e.g. SB-8921"
            setHintTextColor(Color.parseColor("#64748B"))
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#1E293B"))
            textSize = 18f
            typeface = Typeface.MONOSPACE
            gravity = Gravity.CENTER
            setPadding(32, 36, 32, 36)
            val params = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                bottomMargin = 24
            }
            layoutParams = params
        }
        layout.addView(codeInput)

        val deviceNameInput = EditText(this).apply {
            hint = "Device Name (e.g. Rahul's Android Phone)"
            setText("Android Phone")
            setHintTextColor(Color.parseColor("#64748B"))
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#1E293B"))
            textSize = 14f
            setPadding(32, 32, 32, 32)
            val params = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                bottomMargin = 48
            }
            layoutParams = params
        }
        layout.addView(deviceNameInput)

        val pairBtn = Button(this).apply {
            text = "Enroll Device"
            setBackgroundColor(Color.parseColor("#16A34A"))
            setTextColor(Color.WHITE)
            textSize = 16f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(32, 28, 32, 28)
            setOnClickListener {
                val code = codeInput.text.toString().trim().uppercase()
                val devName = deviceNameInput.text.toString().trim().ifBlank { "Android Phone" }
                if (code.isNotEmpty()) {
                    performPairing(code, devName, this)
                } else {
                    Toast.makeText(this@PairingActivity, "Please enter an enrollment code.", Toast.LENGTH_SHORT).show()
                }
            }
            val params = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            layoutParams = params
        }
        layout.addView(pairBtn)

        scroll.removeAllViews()
        scroll.addView(layout)
        setContentView(scroll)
    }

    private fun performPairing(code: String, devName: String, btn: Button) {
        btn.isEnabled = false
        btn.text = "Enrolling Device..."

        val backendUrl = AgentConfig.apiBaseUrl

        val json = JSONObject().apply {
            put("code", code)
            put("deviceName", devName)
            put("platform", "android")
            put("agentVersion", BuildConfig.VERSION_NAME)
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

                // Extract child name from familyProfiles if available
                var matchedChildName = "Rahul"
                val profiles = obj.optJSONArray("familyProfiles")
                if (profiles != null) {
                    val targetChildId = device.optString("childId")
                    for (i in 0 until profiles.length()) {
                        val p = profiles.getJSONObject(i)
                        if (p.optString("id") == targetChildId) {
                            matchedChildName = p.optString("name", matchedChildName)
                            break
                        }
                    }
                }

                val nowStr = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())
                val prefs = getSharedPreferences("safebrowse_device", Context.MODE_PRIVATE)
                prefs.edit()
                    .putString("device_id", device.getString("id"))
                    .putString("device_token", device.getString("deviceToken"))
                    .putString("child_id", device.getString("childId"))
                    .putString("child_name", matchedChildName)
                    .putString("device_name", devName)
                    .putString("last_sync", nowStr)
                    .apply()

                AgentConfig.setBackendUrl(this@PairingActivity, backendUrl)

                if (policyJson != null) {
                    val policy = Gson().fromJson(policyJson.toString(), Policy::class.java)
                    policyManager.savePolicy(policy)
                }

                SyncWorker.schedulePeriodicSync(this@PairingActivity)

                Toast.makeText(this@PairingActivity, "Successfully enrolled!", Toast.LENGTH_SHORT).show()
                requestVpnPermissionAndStart()
                renderStatusScreen()
            } else {
                Toast.makeText(this@PairingActivity, "Enrollment failed. Please check the code.", Toast.LENGTH_SHORT).show()
                btn.isEnabled = true
                btn.text = "Try Again"
            }
        }
    }

    private fun checkAndStartVpn() {
        val vpnIntent = VpnService.prepare(this)
        if (vpnIntent == null && !SafeBrowseVpnService.isServiceRunning) {
            val serviceIntent = Intent(this, SafeBrowseVpnService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent)
            } else {
                startService(serviceIntent)
            }
        }
    }

    private fun requestVpnPermissionAndStart() {
        val vpnIntent = VpnService.prepare(this)
        if (vpnIntent != null) {
            @Suppress("DEPRECATION")
            startActivityForResult(vpnIntent, VPN_REQUEST_CODE)
        } else {
            @Suppress("DEPRECATION")
            onActivityResult(VPN_REQUEST_CODE, RESULT_OK, null)
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == VPN_REQUEST_CODE) {
            if (resultCode == RESULT_OK) {
                val serviceIntent = Intent(this, SafeBrowseVpnService::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(serviceIntent)
                } else {
                    startService(serviceIntent)
                }
                Toast.makeText(this, "SafeBrowse Protection Active", Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(this, "VPN permission is required to protect this device.", Toast.LENGTH_LONG).show()
            }
            renderStatusScreen()
        }
    }
}
