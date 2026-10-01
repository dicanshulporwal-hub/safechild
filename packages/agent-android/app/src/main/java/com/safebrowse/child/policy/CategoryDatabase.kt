package com.safebrowse.child.policy

import java.util.Locale

object CategoryDatabase {

    val CATEGORY_DOMAINS: Map<String, List<String>> = mapOf(
        "ADULT_CONTENT" to listOf(
            "pornhub.com",
            "xvideos.com",
            "xnxx.com",
            "chaturbate.com",
            "onlyfans.com",
            "redtube.com",
            "youporn.com",
            "livejasmin.com"
        ),
        "GAMBLING" to listOf(
            "bet365.com",
            "pokerstars.com",
            "stake.com",
            "draftkings.com",
            "fanduel.com",
            "888casino.com",
            "bovada.lv",
            "betway.com"
        ),
        "GAMING" to listOf(
            "roblox.com",
            "steamcommunity.com",
            "steampowered.com",
            "epicgames.com",
            "twitch.tv",
            "minecraft.net",
            "ea.com",
            "riotgames.com",
            "battlenet.com",
            "ubisoft.com",
            "ign.com"
        ),
        "SOCIAL_MEDIA" to listOf(
            "tiktok.com",
            "instagram.com",
            "snapchat.com",
            "twitter.com",
            "x.com",
            "facebook.com",
            "discord.com",
            "reddit.com",
            "pinterest.com",
            "tumblr.com",
            "threads.net"
        ),
        "ENTERTAINMENT" to listOf(
            "youtube.com",
            "netflix.com",
            "disneyplus.com",
            "hulu.com",
            "spotify.com",
            "primevideo.com",
            "crunchyroll.com",
            "hbomax.com",
            "twitch.tv"
        ),
        "AI_TOOLS" to listOf(
            "chatgpt.com",
            "openai.com",
            "claude.ai",
            "anthropic.com",
            "character.ai",
            "poe.com",
            "perplexity.ai",
            "deepseek.com",
            "midjourney.com",
            "copilot.microsoft.com",
            "quillbot.com",
            "huggingface.co"
        ),
        "PIRACY" to listOf(
            "thepiratebay.org",
            "1337x.to",
            "torrentgalaxy.to",
            "yts.mx",
            "fmovies.to",
            "aniwave.to",
            "fitgirl-repacks.site",
            "rarbg.to",
            "magnetdl.com",
            "nyaa.si"
        ),
        "MALWARE_SECURITY" to listOf(
            "malware-traffic-analysis.net",
            "wicar.org",
            "coinhive.com",
            "crypto-loot.com",
            "bitly.phishing.test"
        ),
        "EDUCATION" to listOf(
            "wikipedia.org",
            "khanacademy.org",
            "duolingo.com",
            "quizlet.com",
            "coursera.org",
            "edx.org",
            "classroom.google.com",
            "brainly.com",
            "sciencedirect.com",
            "nationalgeographic.com",
            "britannica.com",
            "nasa.gov"
        )
    )

    fun categorizeDomain(normalizedDomain: String): String? {
        val norm = normalizedDomain.trim().lowercase(Locale.ROOT)
        if (norm.isBlank()) return null

        for ((category, domains) in CATEGORY_DOMAINS) {
            for (d in domains) {
                if (domainMatches(norm, d)) {
                    return category
                }
            }
        }
        return null
    }

    private fun domainMatches(target: String, ruleDomain: String): Boolean {
        if (target == ruleDomain) return true
        if (ruleDomain.startsWith("*.")) {
            val base = ruleDomain.substring(2)
            if (target == base || target.endsWith(".$base")) return true
        }
        if (target.endsWith(".$ruleDomain")) return true
        return false
    }
}
