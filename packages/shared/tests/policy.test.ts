import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  normalizeDomain,
  domainMatches,
  evaluatePolicy,
  Policy,
  calculateExpirationDate,
  categorizeDomain,
  isWithinBedtime,
} from '../src';

describe('SafeBrowse Policy Engine & Precedence Tests', () => {
  it('should normalize domains properly', () => {
    assert.strictEqual(normalizeDomain('https://www.youtube.com/watch?v=123'), 'youtube.com');
    assert.strictEqual(normalizeDomain('http://m.youtube.com:8080/'), 'm.youtube.com');
    assert.strictEqual(normalizeDomain('Www.REDDIT.Com/r/all/'), 'reddit.com');
    assert.strictEqual(normalizeDomain('wikipedia.org.'), 'wikipedia.org');
  });

  it('should match domains and subdomains correctly', () => {
    assert.strictEqual(domainMatches('youtube.com', 'youtube.com'), true);
    assert.strictEqual(domainMatches('m.youtube.com', 'youtube.com'), true);
    assert.strictEqual(domainMatches('i.ytimg.com', 'youtube.com'), false);
    assert.strictEqual(domainMatches('fakeyoutube.com', 'youtube.com'), false);
    assert.strictEqual(domainMatches('mail.google.com', '*.google.com'), true);
  });

  it('should classify domains into categories accurately', () => {
    assert.strictEqual(categorizeDomain('roblox.com'), 'GAMING');
    assert.strictEqual(categorizeDomain('tiktok.com'), 'SOCIAL_MEDIA');
    assert.strictEqual(categorizeDomain('wikipedia.org'), 'EDUCATION');
    assert.strictEqual(categorizeDomain('pokerstars.com'), 'GAMBLING');
  });

  it('should calculate bedtime window correctly', () => {
    const bedtime = { startHour: 21, startMinute: 30, endHour: 7, endMinute: 0 };
    const lateNight = new Date('2026-08-29T22:00:00');
    assert.strictEqual(isWithinBedtime(lateNight, bedtime), true);

    const earlyMorning = new Date('2026-08-29T03:00:00');
    assert.strictEqual(isWithinBedtime(earlyMorning, bedtime), true);

    const afternoon = new Date('2026-08-29T14:00:00');
    assert.strictEqual(isWithinBedtime(afternoon, bedtime), false);
  });

  describe('Policy Conflict Resolution & Precedence Order', () => {
    const now = new Date('2026-08-29T12:00:00Z');
    const future = new Date('2026-08-29T12:15:00Z').toISOString();

    it('Level 1: Global Internet Pause overrides Temporary Allow, Whitelist and Blacklist', () => {
      const policy: Policy = {
        id: 'p-pause',
        childId: 'c1',
        familyId: 'fam-test',
        version: 1,
        isPaused: true,
        rules: [
          { id: '1', domain: 'youtube.com', action: 'TEMPORARY_ALLOW', addedAt: now.toISOString(), expiresAt: future },
          { id: '2', domain: 'wikipedia.org', action: 'ALLOW', addedAt: now.toISOString() },
        ],
        updatedAt: now.toISOString(),
      };

      const yt = evaluatePolicy(policy, 'youtube.com', now);
      assert.strictEqual(yt.action, 'BLOCK');
      assert.strictEqual(yt.reason, 'PAUSED_INTERNET');

      const wiki = evaluatePolicy(policy, 'wikipedia.org', now);
      assert.strictEqual(wiki.action, 'BLOCK');
      assert.strictEqual(wiki.reason, 'PAUSED_INTERNET');
    });

    it('Level 2: Active Temporary Grant overrides Explicit Blacklist and Category Blocks', () => {
      const policy: Policy = {
        id: 'p-temp',
        childId: 'c1',
        familyId: 'fam-test',
        version: 2,
        isPaused: false,
        categoryControls: [{ category: 'ENTERTAINMENT', action: 'BLOCK' }],
        rules: [
          { id: '1', domain: 'youtube.com', action: 'TEMPORARY_ALLOW', addedAt: now.toISOString(), expiresAt: future },
          { id: '2', domain: 'youtube.com', action: 'BLOCK', addedAt: now.toISOString() },
        ],
        updatedAt: now.toISOString(),
      };

      const yt = evaluatePolicy(policy, 'youtube.com', now);
      assert.strictEqual(yt.action, 'ALLOW');
      assert.strictEqual(yt.reason, 'TEMPORARY_ALLOW');
    });

    it('Level 3: Explicit Whitelist (ALLOW) overrides Category Block', () => {
      const policy: Policy = {
        id: 'p-white',
        childId: 'c1',
        familyId: 'fam-test',
        version: 3,
        isPaused: false,
        categoryControls: [{ category: 'GAMING', action: 'BLOCK' }],
        rules: [
          { id: '1', domain: 'minecraft.net', action: 'ALLOW', addedAt: now.toISOString(), reason: 'Allowed educational game' },
        ],
        updatedAt: now.toISOString(),
      };

      const minecraft = evaluatePolicy(policy, 'minecraft.net', now);
      assert.strictEqual(minecraft.action, 'ALLOW');
      assert.strictEqual(minecraft.reason, 'EXPLICIT_ALLOW');

      const roblox = evaluatePolicy(policy, 'roblox.com', now);
      assert.strictEqual(roblox.action, 'BLOCK');
      assert.strictEqual(roblox.reason, 'CATEGORY_BLOCKED');
    });

    it('Level 4: Study Mode blocks non-educational websites unless explicitly whitelisted', () => {
      const policy: Policy = {
        id: 'p-study',
        childId: 'c1',
        familyId: 'fam-test',
        version: 4,
        isPaused: false,
        studyMode: { active: true, allowedCategories: ['EDUCATION'] },
        rules: [
          { id: '1', domain: 'github.com', action: 'ALLOW', addedAt: now.toISOString() },
        ],
        updatedAt: now.toISOString(),
      };

      // Explicit whitelist allowed during study
      const gh = evaluatePolicy(policy, 'github.com', now);
      assert.strictEqual(gh.action, 'ALLOW');
      assert.strictEqual(gh.reason, 'EXPLICIT_ALLOW');

      // Educational allowed during study
      const wiki = evaluatePolicy(policy, 'wikipedia.org', now);
      assert.strictEqual(wiki.action, 'ALLOW');

      // Entertainment blocked during study
      const twitch = evaluatePolicy(policy, 'twitch.tv', now);
      assert.strictEqual(twitch.action, 'BLOCK');
      assert.strictEqual(twitch.reason, 'STUDY_MODE_ACTIVE');
    });

    it('Level 5: SafeSearch & YouTube Restricted Mode DNS Redirection', () => {
      const policy: Policy = {
        id: 'p-safesearch',
        childId: 'c1',
        familyId: 'fam-test',
        version: 5,
        isPaused: false,
        rules: [],
        safeSearch: {
          googleSafeSearch: true,
          bingSafeSearch: true,
          duckDuckGoSafeSearch: true,
          youtubeRestrictedMode: 'STRICT',
        },
        updatedAt: now.toISOString(),
      };

      const google = evaluatePolicy(policy, 'google.com', now);
      assert.strictEqual(google.action, 'ALLOW');
      assert.strictEqual(google.safeSearchRedirect, 'forcesafesearch.google.com');

      const bing = evaluatePolicy(policy, 'bing.com', now);
      assert.strictEqual(bing.action, 'ALLOW');
      assert.strictEqual(bing.safeSearchRedirect, 'strict.bing.com');

      const ddg = evaluatePolicy(policy, 'duckduckgo.com', now);
      assert.strictEqual(ddg.action, 'ALLOW');
      assert.strictEqual(ddg.safeSearchRedirect, 'safe.duckduckgo.com');

      const yt = evaluatePolicy(policy, 'youtube.com', now);
      assert.strictEqual(yt.action, 'ALLOW');
      assert.strictEqual(yt.safeSearchRedirect, 'restrict.youtube.com');

      const wiki = evaluatePolicy(policy, 'wikipedia.org', now);
      assert.strictEqual(wiki.action, 'ALLOW');
      assert.strictEqual(wiki.safeSearchRedirect, undefined);
    });
  });
});
