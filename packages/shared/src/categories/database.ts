import { WebsiteCategory } from '../types';
import { normalizeDomain } from '../policy/normalizer';
import { domainMatches } from '../policy/matcher';

export const CATEGORY_DOMAINS: Record<WebsiteCategory, string[]> = {
  ADULT_CONTENT: [
    'pornhub.com',
    'xvideos.com',
    'xnxx.com',
    'chaturbate.com',
    'onlyfans.com',
    'redtube.com',
    'youporn.com',
    'livejasmin.com',
  ],
  GAMBLING: [
    'bet365.com',
    'pokerstars.com',
    'stake.com',
    'draftkings.com',
    'fanduel.com',
    '888casino.com',
    'bovada.lv',
    'betway.com',
  ],
  GAMING: [
    'roblox.com',
    'steamcommunity.com',
    'steampowered.com',
    'epicgames.com',
    'twitch.tv',
    'minecraft.net',
    'ea.com',
    'riotgames.com',
    'battlenet.com',
    'ubisoft.com',
    'ign.com',
  ],
  SOCIAL_MEDIA: [
    'tiktok.com',
    'instagram.com',
    'snapchat.com',
    'twitter.com',
    'x.com',
    'facebook.com',
    'discord.com',
    'reddit.com',
    'pinterest.com',
    'tumblr.com',
    'threads.net',
  ],
  ENTERTAINMENT: [
    'youtube.com',
    'netflix.com',
    'disneyplus.com',
    'hulu.com',
    'spotify.com',
    'primevideo.com',
    'crunchyroll.com',
    'hbomax.com',
    'twitch.tv',
  ],
  AI_TOOLS: [
    'chatgpt.com',
    'openai.com',
    'claude.ai',
    'anthropic.com',
    'character.ai',
    'poe.com',
    'perplexity.ai',
    'deepseek.com',
    'midjourney.com',
    'copilot.microsoft.com',
    'quillbot.com',
    'huggingface.co',
  ],
  PIRACY: [
    'thepiratebay.org',
    '1337x.to',
    'torrentgalaxy.to',
    'yts.mx',
    'fmovies.to',
    'aniwave.to',
    'fitgirl-repacks.site',
    'rarbg.to',
    'magnetdl.com',
    'nyaa.si',
  ],
  MALWARE_SECURITY: [
    'malware-traffic-analysis.net',
    'wicar.org',
    'coinhive.com',
    'crypto-loot.com',
    'bitly.phishing.test',
  ],
  EDUCATION: [
    'wikipedia.org',
    'khanacademy.org',
    'duolingo.com',
    'quizlet.com',
    'coursera.org',
    'edx.org',
    'classroom.google.com',
    'brainly.com',
    'sciencedirect.com',
    'nationalgeographic.com',
    'britannica.com',
    'nasa.gov',
  ],
};

/**
 * Classifies a domain into a WebsiteCategory if known
 */
export function categorizeDomain(targetDomain: string): WebsiteCategory | null {
  const norm = normalizeDomain(targetDomain);
  if (!norm) return null;

  for (const [category, domains] of Object.entries(CATEGORY_DOMAINS)) {
    for (const d of domains) {
      if (domainMatches(norm, d)) {
        return category as WebsiteCategory;
      }
    }
  }

  return null;
}
