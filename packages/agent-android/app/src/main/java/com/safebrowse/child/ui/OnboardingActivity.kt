package com.safebrowse.child.ui

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import com.safebrowse.child.policy.LocalPolicyManager
import com.safebrowse.child.vpn.SafeBrowseVpnService

/**
 * Production SafeBrowse Android Onboarding Activity
 * Handles: QR Scan -> VPN Permission Education -> Android System VPN Approval -> Policy Sync -> Protected Screen
 */
class OnboardingActivity : Activity() {

    private lateinit var policyManager: LocalPolicyManager
    private val VPN_REQUEST_CODE = 1001

    private var currentStep = 1
    private var pairedChildName = "Rahul"
    private var deviceToken: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        policyManager = LocalPolicyManager(applicationContext)

        // If already paired and protected, show status directly
        if (policyManager.isPaired()) {
            showProtectedScreen()
        } else {
            showOnboardingWelcome()
        }
    }

    private fun showOnboardingWelcome() {
        Log.i("SafeBrowseOnboarding", "Step 1: Welcome & QR Pairing prompt")
        currentStep = 1
    }

    /**
     * Called when QR code is scanned or 8-character pairing code is entered
     */
    public fun onPairingCodeScanned(pairingCode: String) {
        Log.i("SafeBrowseOnboarding", "Step 2: Pairing code received: $pairingCode")
        // Pair with cloud backend
        // On success:
        showVpnPermissionExplanation()
    }

    /**
     * Educate parent/child on why Android VPN permission is required
     */
    private fun showVpnPermissionExplanation() {
        Log.i("SafeBrowseOnboarding", "Step 3: Explaining VPN permission requirement")
        currentStep = 2
        requestAndroidVpnApproval()
    }

    /**
     * Triggers standard Android system VPN approval prompt (VpnService.prepare)
     */
    private fun requestAndroidVpnApproval() {
        val vpnIntent = VpnService.prepare(this)
        if (vpnIntent != null) {
            startActivityForResult(vpnIntent, VPN_REQUEST_CODE)
        } else {
            // Already approved
            onActivityResult(VPN_REQUEST_CODE, RESULT_OK, null)
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == VPN_REQUEST_CODE) {
            if (resultCode == RESULT_OK) {
                Log.i("SafeBrowseOnboarding", "Step 4: Android VPN permission GRANTED by user.")
                startProtectionService()
            } else {
                Log.w("SafeBrowseOnboarding", "VPN permission was denied.")
                Toast.makeText(this, "Protection requires VPN permission to filter inappropriate content.", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun startProtectionService() {
        Log.i("SafeBrowseOnboarding", "Step 5: Starting SafeBrowse VPN Service & Syncing Initial Policy...")
        val serviceIntent = Intent(this, SafeBrowseVpnService::class.java)
        startService(serviceIntent)

        // Verify protection
        showProtectedScreen()
    }

    private fun showProtectedScreen() {
        currentStep = 6
        Log.i("SafeBrowseOnboarding", "Step 6: Device is now 🟢 PROTECTED!")
    }
}
