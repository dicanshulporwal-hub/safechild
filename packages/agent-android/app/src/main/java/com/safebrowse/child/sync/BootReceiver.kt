package com.safebrowse.child.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.util.Log
import com.safebrowse.child.policy.LocalPolicyManager
import com.safebrowse.child.vpn.SafeBrowseVpnService

/**
 * SafeBrowse Boot Receiver
 * Automatically restarts SafeBrowse VPN protection and sync worker upon device boot.
 */
class BootReceiver : BroadcastReceiver() {

    companion object {
        const val TAG = "SafeBrowseBoot"
    }

    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action == Intent.ACTION_BOOT_COMPLETED ||
            intent?.action == Intent.ACTION_MY_PACKAGE_REPLACED ||
            intent?.action == "android.intent.action.QUICKBOOT_POWERON") {

            Log.i(TAG, "Device boot completed. Checking SafeBrowse enrollment state...")
            val policyManager = LocalPolicyManager(context)

            if (policyManager.isEnrolled()) {
                Log.i(TAG, "Device is enrolled. Auto-starting SafeBrowse protection service...")

                // Check if VPN permission has already been granted
                val prepareIntent = VpnService.prepare(context)
                if (prepareIntent == null) {
                    val serviceIntent = Intent(context, SafeBrowseVpnService::class.java)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        context.startForegroundService(serviceIntent)
                    } else {
                        context.startService(serviceIntent)
                    }
                    Log.i(TAG, "SafeBrowse VPN service restarted successfully on boot.")
                } else {
                    Log.w(TAG, "VPN permission required by user interaction before service start.")
                }

                // Schedule background synchronization worker
                SyncWorker.schedulePeriodicSync(context)
            } else {
                Log.d(TAG, "Device not yet enrolled. Skipping auto-start.")
            }
        }
    }
}
