package com.safebrowse.child.vpn

import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.ParcelFileDescriptor
import android.util.Log
import com.google.gson.Gson
import com.safebrowse.child.config.AgentConfig
import com.safebrowse.child.policy.LocalPolicyManager
import com.safebrowse.child.policy.Policy
import com.safebrowse.child.telemetry.ActivityTelemetryManager
import com.safebrowse.child.ui.BlockScreenActivity
import com.safebrowse.child.usage.UsageTracker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.nio.ByteBuffer
import java.util.Arrays
import kotlin.concurrent.thread

/**
 * Production SafeBrowse Android VpnService
 * Implements real-device local DNS capture, protected upstream forwarding, and synthetic DNS blocking.
 */
class SafeBrowseVpnService : VpnService() {

    private var vpnInterface: ParcelFileDescriptor? = null
    private var isRunning = false
    private lateinit var policyManager: LocalPolicyManager
    private lateinit var activityTelemetry: ActivityTelemetryManager
    private lateinit var usageTracker: UsageTracker
    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    companion object {
        const val TAG = "SafeBrowseVPN"
        const val UPSTREAM_DNS_HOST = "1.1.1.1"
        const val UPSTREAM_DNS_PORT = 53
    }

    override fun onCreate() {
        super.onCreate()
        policyManager = LocalPolicyManager(applicationContext)
        activityTelemetry = ActivityTelemetryManager.getInstance(applicationContext)
        usageTracker = UsageTracker.getInstance(applicationContext)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!isRunning) {
            isRunning = true
            startVpnTunnel()
        }
        return START_STICKY
    }

    private fun startVpnTunnel() {
        try {
            activityTelemetry.start()
            usageTracker.start()
            startHeartbeatLoop()

            val builder = Builder()
                .setSession("SafeBrowse Child Protection")
                .addAddress("10.240.0.2", 32)
                .addDnsServer("10.240.0.2") // Capture DNS into local filter
                .addRoute("10.240.0.2", 32)
                .setMtu(1500)

            vpnInterface = builder.establish()
            Log.i(TAG, "SafeBrowse TUN virtual network established.")

            thread(name = "SafeBrowseVpnLoop") {
                runPacketLoop()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to establish VPN: ${e.message}", e)
        }
    }

    private fun runPacketLoop() {
        val descriptor = vpnInterface?.fileDescriptor ?: return
        val inputStream = FileInputStream(descriptor)
        val outputStream = FileOutputStream(descriptor)
        val packetBuffer = ByteArray(32767)

        while (isRunning) {
            try {
                val length = inputStream.read(packetBuffer)
                if (length > 0) {
                    handleIpPacket(packetBuffer, length, outputStream)
                }
            } catch (e: Exception) {
                if (!isRunning) break
            }
        }
    }

    private fun handleIpPacket(packet: ByteArray, length: Int, outputStream: FileOutputStream) {
        val ipVersion = (packet[0].toInt() shr 4) and 0x0F
        if (ipVersion != 4) return // IPv4 inspection

        val headerLength = (packet[0].toInt() and 0x0F) * 4
        val protocol = packet[9].toInt() and 0xFF

        // 1. Drop Private DNS (DoT - Port 853) over TCP/UDP to prevent encrypted bypass
        if (protocol == 6 || protocol == 17) {
            val destPort = ((packet[headerLength + 2].toInt() and 0xFF) shl 8) or
                    (packet[headerLength + 3].toInt() and 0xFF)

            if (destPort == 853) {
                Log.d(TAG, "Dropping DoT Port 853 to enforce local DNS inspection.")
                return
            }
        }

        // 2. Inspect UDP DNS Queries (Port 53)
        if (protocol == 17) {
            val srcPort = ((packet[headerLength].toInt() and 0xFF) shl 8) or
                    (packet[headerLength + 1].toInt() and 0xFF)
            val destPort = ((packet[headerLength + 2].toInt() and 0xFF) shl 8) or
                    (packet[headerLength + 3].toInt() and 0xFF)

            if (destPort == 53) {
                val udpHeaderLength = 8
                val dnsOffset = headerLength + udpHeaderLength
                val dnsLength = length - dnsOffset

                if (dnsLength > 12) {
                    val query = extractQueryInfoFromDns(packet, dnsOffset, length)
                    if (query != null) {
                        val domain = query.domain
                        val decision = policyManager.evaluate(domain)

                        if (decision.action == "BLOCK") {
                            Log.w(TAG, "🚫 [VpnService] BLOCKED: $domain (Reason: ${decision.reason})")
                            activityTelemetry.recordEvent(
                                domain = domain,
                                action = "BLOCKED",
                                category = decision.category,
                                reason = decision.reason
                            )
                            val blockDnsPacket = buildSyntheticNxDomain(packet, headerLength, length)
                            outputStream.write(blockDnsPacket)
                            notifyBlockedAccess(domain)
                            return
                        } else if (decision.rewriteIp != null) {
                            val act = if (decision.reason == "TEMPORARY_ALLOW") "TEMPORARY_ACCESSED" else "ALLOWED"
                            activityTelemetry.recordEvent(
                                domain = domain,
                                action = act,
                                category = decision.category,
                                reason = decision.reason
                            )
                            usageTracker.recordDomainAccess(domain, decision.category)

                            if (query.qType == 28) {
                                // AAAA (IPv6) query: synthesize authoritative NODATA response so client uses IPv4 VIP
                                Log.i(TAG, "🔒 [VpnService] SAFESEARCH ENFORCED (AAAA NODATA): $domain")
                                val noDataPacket = buildSyntheticNoData(packet, headerLength, length)
                                outputStream.write(noDataPacket)
                                return
                            } else {
                                // A (IPv4) query: synthesize authoritative A-record response with VIP
                                Log.i(TAG, "🔒 [VpnService] SAFESEARCH ENFORCED (A VIP): $domain -> Rewriting to ${decision.rewriteIp}")
                                val safeSearchPacket = buildSyntheticARecord(packet, headerLength, length, decision.rewriteIp)
                                outputStream.write(safeSearchPacket)
                                return
                            }
                        } else {
                            val act = if (decision.reason == "TEMPORARY_ALLOW") "TEMPORARY_ACCESSED" else "ALLOWED"
                            activityTelemetry.recordEvent(
                                domain = domain,
                                action = act,
                                category = decision.category,
                                reason = decision.reason
                            )
                            usageTracker.recordDomainAccess(domain, decision.category)

                            Log.d(TAG, "✅ [VpnService] ALLOWED: $domain -> Forwarding to protected upstream")
                            forwardAllowedDnsQuery(packet, headerLength, length, outputStream)
                            return
                        }
                    }
                }
            }
        }
    }

    /**
     * Forwards allowed DNS query to upstream DNS over an OS-protected socket
     * and returns the upstream DNS response packet into the TUN interface.
     */
    private fun forwardAllowedDnsQuery(
        rawPacket: ByteArray,
        ipHeaderLen: Int,
        totalLen: Int,
        tunOut: FileOutputStream
    ) {
        thread(name = "SafeBrowseUpstreamDns") {
            try {
                val dnsOffset = ipHeaderLen + 8
                val dnsLen = totalLen - dnsOffset
                val dnsPayload = Arrays.copyOfRange(rawPacket, dnsOffset, totalLen)

                val socket = DatagramSocket()
                // Protect socket from VPN looping back into itself
                protect(socket)
                socket.soTimeout = 2500

                val upstreamAddr = InetAddress.getByName(UPSTREAM_DNS_HOST)
                val sendPacket = DatagramPacket(dnsPayload, dnsLen, upstreamAddr, UPSTREAM_DNS_PORT)
                socket.send(sendPacket)

                val recvBuf = ByteArray(2048)
                val recvPacket = DatagramPacket(recvBuf, recvBuf.size)
                socket.receive(recvPacket)
                socket.close()

                // Construct valid return IPv4/UDP packet containing the upstream DNS response
                val responseIpPacket = buildIpUdpPacket(
                    srcIp = Arrays.copyOfRange(rawPacket, 16, 20), // Original Dest IP
                    dstIp = Arrays.copyOfRange(rawPacket, 12, 16), // Original Src IP
                    srcPort = 53,
                    dstPort = ((rawPacket[ipHeaderLen].toInt() and 0xFF) shl 8) or (rawPacket[ipHeaderLen + 1].toInt() and 0xFF),
                    payload = recvPacket.data,
                    payloadLen = recvPacket.length
                )

                tunOut.write(responseIpPacket)
            } catch (e: Exception) {
                Log.w(TAG, "Upstream DNS query error: ${e.message}")
            }
        }
    }

    /**
     * Synthesizes an authoritative NXDOMAIN (Domain Not Found - RCODE 3) response
     */
    private fun buildSyntheticNxDomain(rawPacket: ByteArray, ipHeaderLen: Int, totalLen: Int): ByteArray {
        val dnsOffset = ipHeaderLen + 8
        val dnsPayload = Arrays.copyOfRange(rawPacket, dnsOffset, totalLen)

        // Set QR bit (response), RA bit, and RCODE 3 (NXDOMAIN)
        if (dnsPayload.size > 3) {
            dnsPayload[2] = (dnsPayload[2].toInt() or 0x81).toByte()
            dnsPayload[3] = (dnsPayload[3].toInt() or 0x83).toByte() // NXDOMAIN
        }

        return buildIpUdpPacket(
            srcIp = Arrays.copyOfRange(rawPacket, 16, 20),
            dstIp = Arrays.copyOfRange(rawPacket, 12, 16),
            srcPort = 53,
            dstPort = ((rawPacket[ipHeaderLen].toInt() and 0xFF) shl 8) or (rawPacket[ipHeaderLen + 1].toInt() and 0xFF),
            payload = dnsPayload,
            payloadLen = dnsPayload.size
        )
    }

    /**
     * Synthesizes an authoritative A-record DNS response (RCODE 0 - NOERROR) pointing to an enforced VIP
     */
    fun buildSyntheticARecord(
        rawPacket: ByteArray,
        ipHeaderLen: Int,
        totalLen: Int,
        ipStr: String
    ): ByteArray {
        val dnsOffset = ipHeaderLen + 8
        val dnsPayload = Arrays.copyOfRange(rawPacket, dnsOffset, totalLen)

        // Ensure valid DNS header (at least 12 bytes)
        if (dnsPayload.size >= 12) {
            // Flags: QR=1 (response), AA=1 (authoritative), RA=1 (recursion available), RCODE=0 (no error) -> 0x81, 0x80
            dnsPayload[2] = 0x81.toByte()
            dnsPayload[3] = 0x80.toByte()

            // ANCOUNT = 1 (1 Answer Record)
            dnsPayload[6] = 0x00.toByte()
            dnsPayload[7] = 0x01.toByte()

            // NSCOUNT = 0
            dnsPayload[8] = 0x00.toByte()
            dnsPayload[9] = 0x00.toByte()

            // ARCOUNT = 0
            dnsPayload[10] = 0x00.toByte()
            dnsPayload[11] = 0x00.toByte()
        }

        // Parse target IPv4 address bytes (e.g. 216.239.38.120)
        val ipParts = ipStr.split('.').map { it.toInt().toByte() }.toByteArray()

        // Construct 16-byte DNS Answer record (A record with 60s TTL)
        val answer = ByteBuffer.allocate(16).apply {
            put(0xC0.toByte())
            put(0x0C.toByte())         // Pointer to offset 12 (start of question QNAME)
            putShort(0x0001.toShort()) // Type A
            putShort(0x0001.toShort()) // Class IN
            putInt(60)                 // TTL 60 seconds
            putShort(4.toShort())      // Data length 4
            put(ipParts)               // 4 bytes IP address
        }.array()

        val fullDnsPayload = ByteBuffer.allocate(dnsPayload.size + answer.size).apply {
            put(dnsPayload)
            put(answer)
        }.array()

        return buildIpUdpPacket(
            srcIp = Arrays.copyOfRange(rawPacket, 16, 20), // Original Dest IP becomes Src IP
            dstIp = Arrays.copyOfRange(rawPacket, 12, 16), // Original Src IP becomes Dst IP
            srcPort = 53,
            dstPort = ((rawPacket[ipHeaderLen].toInt() and 0xFF) shl 8) or (rawPacket[ipHeaderLen + 1].toInt() and 0xFF),
            payload = fullDnsPayload,
            payloadLen = fullDnsPayload.size
        )
    }

    /**
     * Synthesizes an authoritative NODATA (RCODE 0 - NOERROR with ANCOUNT = 0) response.
     * Informs dual-stack clients that no IPv6 records exist for this domain, compelling them to use the IPv4 VIP.
     */
    fun buildSyntheticNoData(rawPacket: ByteArray, ipHeaderLen: Int, totalLen: Int): ByteArray {
        val dnsOffset = ipHeaderLen + 8
        val dnsPayload = Arrays.copyOfRange(rawPacket, dnsOffset, totalLen)

        if (dnsPayload.size >= 12) {
            // Flags: QR=1 (response), AA=1 (authoritative), RA=1 (recursion available), RCODE=0 (NOERROR) -> 0x81, 0x80
            dnsPayload[2] = 0x81.toByte()
            dnsPayload[3] = 0x80.toByte()

            // ANCOUNT = 0 (No answer records)
            dnsPayload[6] = 0x00.toByte()
            dnsPayload[7] = 0x00.toByte()

            // NSCOUNT = 0
            dnsPayload[8] = 0x00.toByte()
            dnsPayload[9] = 0x00.toByte()

            // ARCOUNT = 0
            dnsPayload[10] = 0x00.toByte()
            dnsPayload[11] = 0x00.toByte()
        }

        return buildIpUdpPacket(
            srcIp = Arrays.copyOfRange(rawPacket, 16, 20), // Original Dest IP becomes Src IP
            dstIp = Arrays.copyOfRange(rawPacket, 12, 16), // Original Src IP becomes Dst IP
            srcPort = 53,
            dstPort = ((rawPacket[ipHeaderLen].toInt() and 0xFF) shl 8) or (rawPacket[ipHeaderLen + 1].toInt() and 0xFF),
            payload = dnsPayload,
            payloadLen = dnsPayload.size
        )
    }

    data class DnsQuery(val domain: String, val qType: Int)

    private fun extractQueryInfoFromDns(packet: ByteArray, dnsOffset: Int, totalLen: Int): DnsQuery? {
        try {
            var offset = dnsOffset + 12
            val parts = mutableListOf<String>()

            while (offset < totalLen) {
                val len = packet[offset].toInt() and 0xFF
                if (len == 0) {
                    offset += 1
                    break
                }
                if ((len and 0xC0) == 0xC0) {
                    offset += 2
                    break
                }
                offset += 1
                if (offset + len > totalLen) break
                val part = String(packet, offset, len, Charsets.UTF_8)
                parts.add(part)
                offset += len
            }

            if (parts.isEmpty()) return null
            val domain = parts.joinToString(".")
            var qType = 1 // Default to Type A
            if (offset + 2 <= totalLen) {
                qType = ((packet[offset].toInt() and 0xFF) shl 8) or (packet[offset + 1].toInt() and 0xFF)
            }
            return DnsQuery(domain, qType)
        } catch (e: Exception) {
            return null
        }
    }

    private fun extractDomainFromDns(packet: ByteArray, dnsOffset: Int, totalLen: Int): String? {
        return extractQueryInfoFromDns(packet, dnsOffset, totalLen)?.domain
    }

    private fun buildIpUdpPacket(
        srcIp: ByteArray,
        dstIp: ByteArray,
        srcPort: Int,
        dstPort: Int,
        payload: ByteArray,
        payloadLen: Int
    ): ByteArray {
        val totalLength = 20 + 8 + payloadLen
        val packet = ByteBuffer.allocate(totalLength)

        // IPv4 Header (20 bytes)
        packet.put(0x45.toByte()) // Version 4, IHL 5
        packet.put(0x00.toByte()) // DSCP / ECN
        packet.putShort(totalLength.toShort()) // Total Length
        packet.putShort(0x0000.toShort()) // Identification
        packet.putShort(0x4000.toShort()) // Flags (Don't Fragment)
        packet.put(64.toByte()) // TTL
        packet.put(17.toByte()) // Protocol (UDP)
        packet.putShort(0.toShort()) // Checksum (0 for now)
        packet.put(srcIp)
        packet.put(dstIp)

        // UDP Header (8 bytes)
        packet.putShort(srcPort.toShort())
        packet.putShort(dstPort.toShort())
        packet.putShort((8 + payloadLen).toShort())
        packet.putShort(0.toShort()) // UDP Checksum

        // DNS Payload
        packet.put(payload, 0, payloadLen)

        return packet.array()
    }

    private fun notifyBlockedAccess(domain: String) {
        val intent = Intent(applicationContext, BlockScreenActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("EXTRA_BLOCKED_DOMAIN", domain)
        }
        startActivity(intent)
    }

    private fun startHeartbeatLoop() {
        serviceScope.launch {
            val httpClient = OkHttpClient()
            while (isRunning) {
                try {
                    val prefs = applicationContext.getSharedPreferences("safebrowse_device", Context.MODE_PRIVATE)
                    val deviceId = prefs.getString("device_id", null)
                    val deviceToken = prefs.getString("device_token", null)
                    val backendUrl = AgentConfig.getBackendUrl(applicationContext)

                    if (!deviceId.isNullOrBlank() && !deviceToken.isNullOrBlank()) {
                        val activeVersion = policyManager.getPolicy()?.version ?: 1
                        val hasAppUsage = UsageTracker.hasUsageStatsPermission(applicationContext)

                        val payload = JSONObject().apply {
                            put("deviceId", deviceId)
                            put("deviceToken", deviceToken)
                            put("activePolicyVersion", activeVersion)
                            put("enforcementActive", true)
                            put("platform", "android")
                            put("agentVersion", AgentConfig.AGENT_VERSION)
                            put("protectionStatus", "ACTIVE")
                            put("capabilities", JSONObject().apply {
                                put("appUsageAvailable", hasAppUsage)
                                put("dnsFiltering", true)
                                put("safeSearch", true)
                                put("studyMode", true)
                                put("bedtime", true)
                                put("categories", true)
                            })
                        }

                        val body = payload.toString().toRequestBody("application/json".toMediaType())
                        val request = Request.Builder()
                            .url("$backendUrl/api/devices/heartbeat")
                            .addHeader("x-device-id", deviceId)
                            .addHeader("x-device-token", deviceToken)
                            .post(body)
                            .build()

                        val res = httpClient.newCall(request).execute()
                        if (res.isSuccessful) {
                            val resJson = JSONObject(res.body?.string() ?: "{}")
                            if (resJson.optBoolean("policyChanged", false)) {
                                val pReq = Request.Builder()
                                    .url("$backendUrl/api/policies/device/$deviceId")
                                    .addHeader("x-device-id", deviceId)
                                    .addHeader("x-device-token", deviceToken)
                                    .get()
                                    .build()
                                val pRes = httpClient.newCall(pReq).execute()
                                if (pRes.isSuccessful) {
                                    val pData = JSONObject(pRes.body?.string() ?: "{}")
                                    val updatedPolicy = Gson().fromJson(
                                        pData.getJSONObject("policy").toString(),
                                        Policy::class.java
                                    )
                                    policyManager.savePolicy(updatedPolicy)
                                    Log.i(TAG, "Dynamic policy update applied (v${updatedPolicy.version})")
                                }
                            }
                        }
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Heartbeat deferred: ${e.message}")
                }
                delay(45_000)
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        isRunning = false
        serviceScope.cancel()
        activityTelemetry.stop()
        usageTracker.stop()
        vpnInterface?.close()
        vpnInterface = null
        Log.i(TAG, "SafeBrowse VPN Service stopped.")
    }
}
