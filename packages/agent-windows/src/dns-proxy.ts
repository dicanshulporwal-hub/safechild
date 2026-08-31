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
   * Helper to parse query domain name from a raw DNS packet
   */
  private extractDomainFromDnsPacket(buffer: Buffer): string | null {
    try {
      if (buffer.length < 12) return null;
      let offset = 12;
      const parts: string[] = [];

      while (offset < buffer.length) {
        const len = buffer[offset];
        if (len === 0) break;
        if ((len & 0xc0) === 0xc0) {
          // Pointer compression
          break;
        }
        offset += 1;
        if (offset + len > buffer.length) break;
        const part = buffer.toString('utf-8', offset, offset + len);
        parts.push(part);
        offset += len;
      }

      return parts.join('.');
    } catch (e) {
      return null;
    }
  }

  /**
   * Constructs an authoritative NXDOMAIN (RCODE 3 - Non-Existent Domain) response.
   * This cleanly denies connection without HTTPS certificate mismatch or ERR_CONNECTION_REFUSED.
   */
  private buildNxDomainResponse(queryBuffer: Buffer): Buffer {
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

  public start(port: number = 53): Promise<number> {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');

      this.socket.on('message', (msg, rinfo) => {
        const domain = this.extractDomainFromDnsPacket(msg);
        const policy = this.getPolicy();

        if (domain && policy) {
          const result = evaluatePolicy(policy, domain);

          if (result.action === 'BLOCK') {
            console.log(`[Windows DNS Filter] 🚫 BLOCKED: ${domain} (Reason: ${result.reason}) -> Returning NXDOMAIN`);
            const blockResp = this.buildNxDomainResponse(msg);
            this.socket?.send(blockResp, rinfo.port, rinfo.address);
            return;
          } else {
            console.log(`[Windows DNS Filter] ✅ ALLOWED: ${domain} -> Forwarding upstream`);
          }
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
        console.log(`[Windows DNS Filter] SafeBrowse DNS Interception Proxy listening on 127.0.0.1:${port}`);
        resolve(port);
      });
    });
  }

  public stop() {
    this.socket?.close();
  }
}
