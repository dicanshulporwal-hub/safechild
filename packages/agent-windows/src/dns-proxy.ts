import dgram from 'dgram';
import { evaluatePolicy, Policy } from '@safebrowse/shared';

export class DnsFilterProxy {
  private socket: dgram.Socket | null = null;
  private getPolicy: () => Policy | null;
  private upstreamDnsHost: string;
  private upstreamDnsPort: number;

  constructor(
    getPolicy: () => Policy | null,
    upstreamDnsHost: string = '1.1.1.1',
    upstreamDnsPort: number = 53
  ) {
    this.getPolicy = getPolicy;
    this.upstreamDnsHost = upstreamDnsHost;
    this.upstreamDnsPort = upstreamDnsPort;
  }

  /**
   * Helper to parse query domain name and QTYPE from a raw DNS packet
   */
  public extractQueryFromDnsPacket(buffer: Buffer): { domain: string; qtype: number } | null {
    try {
      if (buffer.length < 12) return null;
      let offset = 12;
      const parts: string[] = [];

      while (offset < buffer.length) {
        const len = buffer[offset];
        if (len === 0) {
          offset++;
          break;
        }
        if ((len & 0xc0) === 0xc0) {
          offset += 2;
          break;
        }
        offset += 1;
        if (offset + len > buffer.length) break;
        const part = buffer.toString('utf-8', offset, offset + len);
        parts.push(part);
        offset += len;
      }

      if (parts.length === 0) return null;
      const domain = parts.join('.');
      let qtype = 1; // Default Type A
      if (offset + 2 <= buffer.length) {
        qtype = buffer.readUInt16BE(offset);
      }
      return { domain, qtype };
    } catch (e) {
      return null;
    }
  }

  private extractDomainFromDnsPacket(buffer: Buffer): string | null {
    return this.extractQueryFromDnsPacket(buffer)?.domain ?? null;
  }

  /**
   * Constructs an authoritative NXDOMAIN (RCODE 3 - Non-Existent Domain) response.
   * This cleanly denies connection without HTTPS certificate mismatch or ERR_CONNECTION_REFUSED.
   */
  public buildNxDomainResponse(queryBuffer: Buffer): Buffer {
    try {
      const response = Buffer.from(queryBuffer);
      // Flags: QR = 1 (response), AA = 1 (auth), RA = 1 (recursion available), RCODE = 3 (NXDOMAIN)
      response[2] = 0x81; // 1000 0001
      response[3] = 0x83; // 1000 0011 (RCODE 3 = NXDOMAIN)

      // Answer count: 0
      response[6] = 0x00;
      response[7] = 0x00;

      // Authority count: 0
      response[8] = 0x00;
      response[9] = 0x00;

      // Additional count: 0
      response[10] = 0x00;
      response[11] = 0x00;

      return response;
    } catch (e) {
      return queryBuffer;
    }
  }

  /**
   * Constructs an authoritative NODATA (RCODE 0 - NOERROR with ANCOUNT = 0) response.
   * Tells dual-stack clients that no IPv6 records exist for this domain, compelling them to use the IPv4 VIP.
   */
  public buildNoDataResponse(queryBuffer: Buffer): Buffer {
    try {
      const response = Buffer.from(queryBuffer);
      // Flags: QR = 1 (response), AA = 1 (auth), RA = 1 (recursion available), RCODE = 0 (NOERROR)
      response[2] = 0x81; // 1000 0001
      response[3] = 0x80; // 1000 0000 (RCODE 0 = NOERROR)

      // Answer count: 0
      response[6] = 0x00;
      response[7] = 0x00;

      // Authority count: 0
      response[8] = 0x00;
      response[9] = 0x00;

      // Additional count: 0
      response[10] = 0x00;
      response[11] = 0x00;

      return response;
    } catch (e) {
      return queryBuffer;
    }
  }

  /**
   * Constructs an authoritative A-record DNS response pointing to an enforced VIP
   */
  public buildARecordResponse(queryBuffer: Buffer, ipStr: string): Buffer {
    try {
      const ipParts = ipStr.split('.').map(Number);
      const response = Buffer.from(queryBuffer);
      response[2] = 0x81; // Standard query response, No error
      response[3] = 0x80;
      response[4] = 0x00; // QDCOUNT = 1
      response[5] = 0x01;
      response[6] = 0x00; // ANCOUNT = 1
      response[7] = 0x01;
      response[8] = 0x00;
      response[9] = 0x00;
      response[10] = 0x00;
      response[11] = 0x00;

      const answer = Buffer.from([
        0xc0, 0x0c, // Pointer to Question Name
        0x00, 0x01, // Type A
        0x00, 0x01, // Class IN
        0x00, 0x00, 0x00, 0x3c, // TTL 60s
        0x00, 0x04, // Data Length 4
        ipParts[0], ipParts[1], ipParts[2], ipParts[3],
      ]);

      return Buffer.concat([response, answer]);
    } catch (e) {
      return queryBuffer;
    }
  }

  /**
   * Check if the domain requires SafeSearch / YouTube Restricted DNS rewrite
   */
  public checkSafeSearchRewrite(domain: string, policy: Policy): string | null {
    const safeSearch = policy.safeSearch;
    if (!safeSearch) return null;

    const lower = domain.toLowerCase();

    // Google SafeSearch: forcesafesearch.google.com (216.239.38.120)
    if (safeSearch.googleSafeSearch && (lower === 'google.com' || lower.endsWith('.google.com') || lower.startsWith('google.') || lower.startsWith('www.google.'))) {
      return '216.239.38.120';
    }

    // Bing Strict SafeSearch: strict.bing.com (204.79.197.220)
    if (safeSearch.bingSafeSearch && (lower === 'bing.com' || lower.endsWith('.bing.com'))) {
      return '204.79.197.220';
    }

    // DuckDuckGo SafeSearch: safe.duckduckgo.com (52.142.124.215)
    if (safeSearch.duckDuckGoSafeSearch && (lower === 'duckduckgo.com' || lower.endsWith('.duckduckgo.com'))) {
      return '52.142.124.215';
    }

    // YouTube Restricted Mode: restrict.youtube.com (216.239.38.119)
    if (
      safeSearch.youtubeRestrictedMode &&
      safeSearch.youtubeRestrictedMode !== 'OFF' &&
      (lower === 'youtube.com' || lower.endsWith('.youtube.com') || lower === 'youtubei.googleapis.com')
    ) {
      return '216.239.38.119';
    }

    return null;
  }

  public start(port: number = 53): Promise<number> {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');

      this.socket.on('message', (msg, rinfo) => {
        const query = this.extractQueryFromDnsPacket(msg);
        const policy = this.getPolicy();

        if (query && policy) {
          const { domain, qtype } = query;
          const result = evaluatePolicy(policy, domain);

          if (result.action === 'BLOCK') {
            console.log(`[Windows DNS Filter] [BLOCK] BLOCKED: ${domain} (Reason: ${result.reason}) -> Returning NXDOMAIN`);
            const blockResp = this.buildNxDomainResponse(msg);
            this.socket?.send(blockResp, rinfo.port, rinfo.address);
            return;
          }

          // Check for SafeSearch / YouTube Restricted DNS Rewriting
          const rewriteIp = this.checkSafeSearchRewrite(domain, policy);
          if (rewriteIp) {
            if (qtype === 28) {
              // AAAA query for SafeSearch domain -> Return NODATA so client falls back to IPv4 VIP
              console.log(`[Windows DNS Filter] [SAFESEARCH] SAFESEARCH ENFORCED (AAAA NODATA): ${domain}`);
              const noDataResp = this.buildNoDataResponse(msg);
              this.socket?.send(noDataResp, rinfo.port, rinfo.address);
              return;
            } else {
              // A or other query -> Return enforced IPv4 VIP
              console.log(`[Windows DNS Filter] [SAFESEARCH] SAFESEARCH ENFORCED (A VIP): ${domain} -> Rewriting to ${rewriteIp}`);
              const safeSearchResp = this.buildARecordResponse(msg, rewriteIp);
              this.socket?.send(safeSearchResp, rinfo.port, rinfo.address);
              return;
            }
          }

          console.log(`[Windows DNS Filter] [ALLOWED] ALLOWED: ${domain} -> Forwarding upstream`);
        } else if (query && !policy) {
          console.log(`[Windows DNS Filter] [WARN] [DEGRADED_POLICY_UNAVAILABLE] No active policy available. Forwarding ${query.domain} to upstream DNS.`);
        }

        // Forward allowed queries to upstream DNS (e.g. 1.1.1.1)
        const upstreamClient = dgram.createSocket('udp4');
        upstreamClient.send(msg, this.upstreamDnsPort, this.upstreamDnsHost, (err) => {
          if (err) {
            upstreamClient.close();
          }
        });

        upstreamClient.on('message', (upstreamResponse) => {
          this.socket?.send(upstreamResponse, rinfo.port, rinfo.address);
          upstreamClient.close();
        });

        upstreamClient.on('error', () => {
          upstreamClient.close();
        });
      });

      this.socket.on('error', (err: any) => {
        if (err.code === 'EACCES' || err.code === 'EADDRINUSE') {
          console.warn(`[Windows DNS Filter] Port ${port} unavailable (requires admin or in use). Retrying on fallback port 5353...`);
          this.socket?.close();
          const fallbackSocket = dgram.createSocket('udp4');
          this.socket = fallbackSocket;
          fallbackSocket.bind(5353, '127.0.0.1', () => {
            console.log(`[Windows DNS Filter] Listening on fallback 127.0.0.1:5353`);
            resolve(5353);
          });
        } else {
          console.error('[Windows DNS Filter] Socket error:', err);
          reject(err);
        }
      });

      this.socket.bind(port, '127.0.0.1', () => {
        const boundPort = this.socket ? this.socket.address().port : port;
        console.log(`[Windows DNS Filter] SafeBrowse DNS Interception Proxy listening on 127.0.0.1:${boundPort}`);
        resolve(boundPort);
      });
    });
  }

  public stop() {
    this.socket?.close();
  }
}
