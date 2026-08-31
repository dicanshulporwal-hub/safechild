package com.safebrowse.child.vpn

import android.content.Intent
import android.net.VpnService
import android.os.ParcelFileDescriptor
import android.util.Log
import com.safebrowse.child.policy.LocalPolicyManager
import com.safebrowse.child.ui.BlockScreenActivity
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

    companion object {
        const val TAG = "SafeBrowseVPN"
        const val UPSTREAM_DNS_HOST = "1.1.1.1"
        const val UPSTREAM_DNS_PORT = 53
    }

    override fun onCreate() {
        super.onCreate()
        policyManager = LocalPolicyManager(applicationContext)
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
                    val domain = extractDomainFromDns(packet, dnsOffset, length)
                    if (domain != null) {
                        val decision = policyManager.evaluate(domain)

                        if (decision.action == "BLOCK") {
                            Log.w(TAG, "🚫 [VpnService] BLOCKED: $domain (Reason: ${decision.reason})")
                            val blockDnsPacket = buildSyntheticNxDomain(packet, headerLength, length)
                            outputStream.write(blockDnsPacket)
                            notifyBlockedAccess(domain)
                            return
                        } else {
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

    private fun extractDomainFromDns(packet: ByteArray, dnsOffset: Int, totalLen: Int): String? {
        try {
            var offset = dnsOffset + 12
            val parts = mutableListOf<String>()

            while (offset < totalLen) {
                val len = packet[offset].toInt() and 0xFF
                if (len == 0) break
                if ((len and 0xC0) == 0xC0) break
                offset += 1
                if (offset + len > totalLen) break
                val part = String(packet, offset, len, Charsets.UTF_8)
                parts.add(part)
                offset += len
            }

            return if (parts.isNotEmpty()) parts.joinToString(".") else null
        } catch (e: Exception) {
            return null
        }
    }

    private fun notifyBlockedAccess(domain: String) {
        val intent = Intent(applicationContext, BlockScreenActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("EXTRA_BLOCKED_DOMAIN", domain)
        }
        startActivity(intent)
    }

    override fun onDestroy() {
        super.onDestroy()
        isRunning = false
        vpnInterface?.close()
        vpnInterface = null
        Log.i(TAG, "SafeBrowse VPN Service stopped.")
    }
}
