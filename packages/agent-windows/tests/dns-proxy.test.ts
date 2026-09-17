import { describe, it } from 'node:test';
import assert from 'node:assert';
import { DnsFilterProxy } from '../src/dns-proxy';
import { Policy, SafeSearchConfig } from '@safebrowse/shared';

describe('SafeBrowse Windows DNS Proxy & SafeSearch VIP Tests', () => {
  const proxy = new DnsFilterProxy(() => null);

  const basePolicy: Policy = {
    id: 'pol-test',
    childId: 'child-1',
    familyId: 'fam-1',
    version: 1,
    isPaused: false,
    rules: [],
    safeSearch: {
      googleSafeSearch: true,
      bingSafeSearch: true,
      duckDuckGoSafeSearch: true,
      youtubeRestrictedMode: 'STRICT',
    },
    updatedAt: new Date().toISOString(),
  };

  it('1. should match Google domains and return Google SafeSearch VIP 216.239.38.120', () => {
    assert.strictEqual(proxy.checkSafeSearchRewrite('google.com', basePolicy), '216.239.38.120');
    assert.strictEqual(proxy.checkSafeSearchRewrite('www.google.com', basePolicy), '216.239.38.120');
    assert.strictEqual(proxy.checkSafeSearchRewrite('google.co.uk', basePolicy), '216.239.38.120');
    assert.strictEqual(proxy.checkSafeSearchRewrite('sub.google.com', basePolicy), '216.239.38.120');
  });

  it('2. should match Bing domains and return Bing SafeSearch VIP 204.79.197.220', () => {
    assert.strictEqual(proxy.checkSafeSearchRewrite('bing.com', basePolicy), '204.79.197.220');
    assert.strictEqual(proxy.checkSafeSearchRewrite('www.bing.com', basePolicy), '204.79.197.220');
  });

  it('3. should match DuckDuckGo domains and return DuckDuckGo VIP 52.142.124.215', () => {
    assert.strictEqual(proxy.checkSafeSearchRewrite('duckduckgo.com', basePolicy), '52.142.124.215');
    assert.strictEqual(proxy.checkSafeSearchRewrite('safe.duckduckgo.com', basePolicy), '52.142.124.215');
  });

  it('4. should match YouTube domains and return YouTube Restricted VIP 216.239.38.119', () => {
    assert.strictEqual(proxy.checkSafeSearchRewrite('youtube.com', basePolicy), '216.239.38.119');
    assert.strictEqual(proxy.checkSafeSearchRewrite('www.youtube.com', basePolicy), '216.239.38.119');
    assert.strictEqual(proxy.checkSafeSearchRewrite('youtubei.googleapis.com', basePolicy), '216.239.38.119');
  });

  it('5. should not rewrite when SafeSearch is OFF or disabled', () => {
    const disabledPolicy: Policy = {
      ...basePolicy,
      safeSearch: {
        googleSafeSearch: false,
        bingSafeSearch: false,
        duckDuckGoSafeSearch: false,
        youtubeRestrictedMode: 'OFF',
      },
    };
    assert.strictEqual(proxy.checkSafeSearchRewrite('google.com', disabledPolicy), null);
    assert.strictEqual(proxy.checkSafeSearchRewrite('bing.com', disabledPolicy), null);
    assert.strictEqual(proxy.checkSafeSearchRewrite('youtube.com', disabledPolicy), null);
  });

  it('6. should extract query domain and QTYPE from raw DNS buffer', () => {
    // Standard DNS query packet for 'example.com' (Type A = 1)
    const rawQuery = Buffer.from([
      0xab, 0xcd, // Transaction ID
      0x01, 0x00, // Standard query
      0x00, 0x01, // QDCOUNT = 1
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x07, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, // example
      0x03, 0x63, 0x6f, 0x6d, // com
      0x00, // root
      0x00, 0x01, // QTYPE = A (1)
      0x00, 0x01, // QCLASS = IN
    ]);

    const parsed = proxy.extractQueryFromDnsPacket(rawQuery);
    assert.ok(parsed);
    assert.strictEqual(parsed.domain, 'example.com');
    assert.strictEqual(parsed.qtype, 1);
  });

  it('7. should extract QTYPE 28 (AAAA IPv6) from DNS buffer', () => {
    // DNS query for 'google.com' (Type AAAA = 28)
    const rawAaaaQuery = Buffer.from([
      0x11, 0x22, // ID
      0x01, 0x00, // Flags
      0x00, 0x01, // QDCOUNT = 1
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x06, 0x67, 0x6f, 0x6f, 0x67, 0x6c, 0x65, // google
      0x03, 0x63, 0x6f, 0x6d, // com
      0x00, // root
      0x00, 0x1c, // QTYPE = AAAA (28 = 0x1c)
      0x00, 0x01, // QCLASS = IN
    ]);

    const parsed = proxy.extractQueryFromDnsPacket(rawAaaaQuery);
    assert.ok(parsed);
    assert.strictEqual(parsed.domain, 'google.com');
    assert.strictEqual(parsed.qtype, 28);
  });

  it('8. should build authoritative NXDOMAIN response (RCODE 3)', () => {
    const rawQuery = Buffer.from([0xaa, 0xbb, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const response = proxy.buildNxDomainResponse(rawQuery);
    assert.strictEqual(response[2], 0x81);
    assert.strictEqual(response[3] & 0x0f, 3); // RCODE 3 = NXDOMAIN
    assert.strictEqual(response.readUInt16BE(6), 0); // ANCOUNT = 0
  });

  it('9. should build authoritative NODATA response (RCODE 0, ANCOUNT 0) for AAAA queries', () => {
    const rawQuery = Buffer.from([0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const response = proxy.buildNoDataResponse(rawQuery);
    assert.strictEqual(response[2], 0x81);
    assert.strictEqual(response[3] & 0x0f, 0); // RCODE 0 = NOERROR
    assert.strictEqual(response.readUInt16BE(6), 0); // ANCOUNT = 0
  });

  it('10. should build authoritative A-record response with target IPv4 address', () => {
    const rawQuery = Buffer.from([
      0x55, 0x66, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x06, 0x67, 0x6f, 0x6f, 0x67, 0x6c, 0x65, 0x03, 0x63, 0x6f, 0x6d, 0x00,
      0x00, 0x01, 0x00, 0x01
    ]);
    const response = proxy.buildARecordResponse(rawQuery, '216.239.38.120');
    assert.strictEqual(response.readUInt16BE(6), 1); // ANCOUNT = 1
    // Last 4 bytes should be 216.239.38.120
    const len = response.length;
    assert.strictEqual(response[len - 4], 216);
    assert.strictEqual(response[len - 3], 239);
    assert.strictEqual(response[len - 2], 38);
    assert.strictEqual(response[len - 1], 120);
  });
});
