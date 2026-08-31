import {
  Policy,
  PolicyEvaluationResult,
  PolicyRule,
  WebsiteCategory,
  DetailedPolicyDecision,
  MatchedRuleType,
  SafeSearchConfig,
  UsageBudget,
} from '../types';
import { domainMatches } from './matcher';
import { normalizeDomain } from './normalizer';
import { categorizeDomain } from '../categories/database';

/**
 * Checks if current time falls within a Bedtime schedule
 */
export function isWithinBedtime(
  currentTime: Date,
  bedtime: { startHour: number; startMinute: number; endHour: number; endMinute: number }
): boolean {
  const currentMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();
  const startMinutes = bedtime.startHour * 60 + bedtime.startMinute;
  const endMinutes = bedtime.endHour * 60 + bedtime.endMinute;

  if (startMinutes > endMinutes) {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  } else {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
}

/**
 * Evaluates SafeSearch / YouTube Restricted redirection for a domain
 */
export function getSafeSearchRedirect(
  domain: string,
  config?: SafeSearchConfig
): string | null {
  if (!config) return null;

  const norm = normalizeDomain(domain);

  // 1. Google SafeSearch
  if (config.googleSafeSearch && (norm === 'google.com' || norm.startsWith('google.') || norm.includes('.google.'))) {
    if (!norm.includes('forcesafesearch')) {
      return 'forcesafesearch.google.com';
    }
  }

  // 2. Bing SafeSearch
  if (config.bingSafeSearch && (norm === 'bing.com' || norm.endsWith('.bing.com'))) {
    if (!norm.startsWith('strict.')) {
      return 'strict.bing.com';
    }
  }

  // 3. DuckDuckGo SafeSearch
  if (config.duckDuckGoSafeSearch && (norm === 'duckduckgo.com' || norm.endsWith('.duckduckgo.com'))) {
    if (!norm.startsWith('safe.')) {
      return 'safe.duckduckgo.com';
    }
  }

  // 4. YouTube Restricted Mode
  if (config.youtubeRestrictedMode && config.youtubeRestrictedMode !== 'OFF') {
    if (norm === 'youtube.com' || norm.endsWith('.youtube.com') || norm === 'youtubei.googleapis.com') {
      return config.youtubeRestrictedMode === 'STRICT'
        ? 'restrict.youtube.com'
        : 'restrictmoderate.youtube.com';
    }
  }

  return null;
}

/**
 * Fast Policy Evaluator (Used in DNS proxies, VpnService, and Agent loops)
 */
export function evaluatePolicy(
  policy: Policy,
  targetDomain: string,
  currentTime: Date = new Date(),
  currentUsageSeconds: number = 0
): PolicyEvaluationResult {
  const normDomain = normalizeDomain(targetDomain);
  const detectedCategory = categorizeDomain(normDomain);

  // Check SafeSearch DNS Redirection
  const safeSearchRedirect = getSafeSearchRedirect(normDomain, policy.safeSearch);

  // 1. Level 1: Essential Allow List (Always Available, overrides Pause & Study)
  if (policy.essentialAllowList && policy.essentialAllowList.length > 0) {
    const essentialMatch = policy.essentialAllowList.find((d) => domainMatches(normDomain, d));
    if (essentialMatch) {
      return {
        action: 'ALLOW',
        reason: 'ESSENTIAL_ALLOW',
        matchedRuleType: 'ESSENTIAL_ALLOW',
        matchedDomain: essentialMatch,
        safeSearchRedirect: safeSearchRedirect || undefined,
        explanation: `Always Available: '${essentialMatch}' is in Essential Resources`,
      };
    }
  }

  // 2. Level 2: Internet Pause
  if (policy.isPaused) {
    if (policy.pauseExpiresAt) {
      const pauseExpiry = new Date(policy.pauseExpiresAt);
      if (currentTime < pauseExpiry) {
        return {
          action: 'BLOCK',
          reason: 'PAUSED_INTERNET',
          matchedRuleType: 'PAUSED_INTERNET',
          expiresAt: policy.pauseExpiresAt,
          explanation: 'Internet is currently paused by parent',
        };
      }
    } else {
      return {
        action: 'BLOCK',
        reason: 'PAUSED_INTERNET',
        matchedRuleType: 'PAUSED_INTERNET',
        explanation: 'Internet is currently paused by parent',
      };
    }
  }

  // 3. Level 3: Screen Time / Usage Budget Limits
  if (policy.usageBudgets && policy.usageBudgets.length > 0) {
    const matchingBudget = policy.usageBudgets.find((b) => {
      if (!b.enabled) return false;
      if (b.targetType === 'DOMAIN' && domainMatches(normDomain, b.target)) return true;
      if (b.targetType === 'CATEGORY' && b.target === detectedCategory) return true;
      if (b.targetType === 'APP' && (b.target.toLowerCase() === normDomain || domainMatches(normDomain, b.target))) return true;
      return false;
    });

    if (matchingBudget && !matchingBudget.unlimitedToday) {
      const totalAllowanceSeconds =
        matchingBudget.dailyLimitSeconds + (matchingBudget.bonusSeconds || 0);

      if (currentUsageSeconds >= totalAllowanceSeconds) {
        return {
          action: 'BLOCK',
          reason: 'USAGE_LIMIT_EXHAUSTED',
          matchedRuleType: 'USAGE_LIMIT_EXHAUSTED',
          matchedDomain: matchingBudget.target,
          budgetInfo: {
            dailyLimitSeconds: matchingBudget.dailyLimitSeconds,
            consumedSeconds: currentUsageSeconds,
            remainingSeconds: 0,
            resetTime: matchingBudget.resetTime || '12:00 AM',
          },
          explanation: `Daily screen-time limit of ${Math.round(
            matchingBudget.dailyLimitSeconds / 60
          )} minutes reached for '${matchingBudget.target}'`,
        };
      }
    }
  }

  // 4. Level 4: Temporary Parental Grant (Active TTL)
  const tempAllowRule = policy.rules.find((r) => {
    if (r.action !== 'TEMPORARY_ALLOW') return false;
    if (!domainMatches(normDomain, r.domain)) return false;
    if (!r.expiresAt) return false;
    const expires = new Date(r.expiresAt);
    return currentTime < expires;
  });

  if (tempAllowRule) {
    return {
      action: 'ALLOW',
      reason: 'TEMPORARY_ALLOW',
      matchedRuleType: 'TEMPORARY_GRANT',
      matchedRule: tempAllowRule,
      matchedDomain: tempAllowRule.domain,
      expiresAt: tempAllowRule.expiresAt,
      safeSearchRedirect: safeSearchRedirect || undefined,
      explanation: `Parent temporarily approved access until ${new Date(tempAllowRule.expiresAt!).toLocaleTimeString()}`,
    };
  }

  // 5. Level 5: Explicit Whitelist (ALLOW)
  const explicitAllowRule = policy.rules.find(
    (r) => r.action === 'ALLOW' && domainMatches(normDomain, r.domain)
  );

  if (explicitAllowRule) {
    return {
      action: 'ALLOW',
      reason: 'EXPLICIT_ALLOW',
      matchedRuleType: 'EXPLICIT_ALLOW',
      matchedRule: explicitAllowRule,
      matchedDomain: explicitAllowRule.domain,
      safeSearchRedirect: safeSearchRedirect || undefined,
      explanation: `Explicitly allowed website rule for '${explicitAllowRule.domain}'`,
    };
  }

  // 6. Level 6: Explicit Blacklist (BLOCK)
  const explicitBlockRule = policy.rules.find(
    (r) => r.action === 'BLOCK' && domainMatches(normDomain, r.domain)
  );

  if (explicitBlockRule) {
    return {
      action: 'BLOCK',
      reason: 'EXPLICIT_BLOCK',
      matchedRuleType: 'EXPLICIT_BLOCK',
      matchedRule: explicitBlockRule,
      matchedDomain: explicitBlockRule.domain,
      explanation: `Explicitly blocked by parent rule${explicitBlockRule.reason ? `: ${explicitBlockRule.reason}` : ''}`,
    };
  }

  // 7. Level 7: Study Mode
  if (policy.studyMode?.active) {
    const isEdu = detectedCategory === 'EDUCATION';
    if (!isEdu) {
      return {
        action: 'BLOCK',
        reason: 'STUDY_MODE_ACTIVE',
        matchedRuleType: 'STUDY_MODE',
        matchedCategory: detectedCategory || undefined,
        explanation: 'Study Mode is active. Only educational websites are permitted.',
      };
    }
  }

  // 8. Level 8: Bedtime Schedule
  if (policy.bedtime?.enabled) {
    if (isWithinBedtime(currentTime, policy.bedtime)) {
      const isEdu = detectedCategory === 'EDUCATION';
      if (!policy.bedtime.allowEducationalOnly || !isEdu) {
        return {
          action: 'BLOCK',
          reason: 'BEDTIME_ACTIVE',
          matchedRuleType: 'BEDTIME',
          matchedCategory: detectedCategory || undefined,
          explanation: 'Bedtime Routine active. Non-essential websites are locked at night.',
        };
      }
    }
  }

  // 9. Level 9: Category Controls
  if (policy.categoryControls && detectedCategory) {
    const catControl = policy.categoryControls.find((c) => c.category === detectedCategory);
    if (catControl && catControl.action === 'BLOCK') {
      return {
        action: 'BLOCK',
        reason: 'CATEGORY_BLOCKED',
        matchedRuleType: 'CATEGORY',
        matchedCategory: detectedCategory,
        explanation: `Blocked under category '${detectedCategory}'`,
      };
    }
  }

  // 10. Level 10: Default Fallback
  return {
    action: 'ALLOW',
    reason: 'DEFAULT_ALLOW',
    matchedRuleType: 'DEFAULT',
    safeSearchRedirect: safeSearchRedirect || undefined,
    explanation: 'Allowed by default policy',
  };
}

/**
 * Detailed Policy Evaluator for the Policy Simulator and Explainability
 */
export function evaluatePolicyDetailed(
  policy: Policy,
  targetDomain: string,
  currentTime: Date = new Date(),
  simulatedUsageSeconds: number = 0
): DetailedPolicyDecision {
  const normDomain = normalizeDomain(targetDomain);
  const detectedCategory = categorizeDomain(normDomain);
  const trace: DetailedPolicyDecision['evaluationTrace'] = [];

  // Level 1: Essential Allow List
  const essentialMatch = policy.essentialAllowList?.find((d) => domainMatches(normDomain, d));
  trace.push({
    level: '1. Essential Allow List',
    evaluated: true,
    matched: Boolean(essentialMatch),
    resultAction: essentialMatch ? 'ALLOW' : undefined,
    detail: essentialMatch ? `Matched '${essentialMatch}'` : 'Not in essential list',
  });
  if (essentialMatch) {
    return {
      action: 'ALLOW',
      matchedRuleType: 'ESSENTIAL_ALLOW',
      matchedDomain: essentialMatch,
      policyVersion: policy.version,
      reason: `Always Available: '${essentialMatch}' is an Essential Resource.`,
      evaluationTrace: trace,
    };
  }

  // Level 2: Internet Pause
  const isPausedActive = Boolean(
    policy.isPaused && (!policy.pauseExpiresAt || currentTime < new Date(policy.pauseExpiresAt))
  );
  trace.push({
    level: '2. Internet Pause',
    evaluated: true,
    matched: isPausedActive,
    resultAction: isPausedActive ? 'BLOCK' : undefined,
    detail: isPausedActive ? 'Global Internet Pause is Active' : 'Internet is Unpaused',
  });
  if (isPausedActive) {
    return {
      action: 'BLOCK',
      matchedRuleType: 'PAUSED_INTERNET',
      policyVersion: policy.version,
      expiresAt: policy.pauseExpiresAt,
      reason: 'Internet is currently paused for all child devices.',
      evaluationTrace: trace,
    };
  }

  // Level 3: Screen Time / Usage Budget Limits
  const matchingBudget = policy.usageBudgets?.find((b) => {
    if (!b.enabled) return false;
    if (b.targetType === 'DOMAIN' && domainMatches(normDomain, b.target)) return true;
    if (b.targetType === 'CATEGORY' && b.target === detectedCategory) return true;
    if (b.targetType === 'APP' && (b.target.toLowerCase() === normDomain || domainMatches(normDomain, b.target))) return true;
    return false;
  });

  const isBudgetExhausted = Boolean(
    matchingBudget &&
      !matchingBudget.unlimitedToday &&
      simulatedUsageSeconds >=
        matchingBudget.dailyLimitSeconds + (matchingBudget.bonusSeconds || 0)
  );

  trace.push({
    level: '3. Screen Time & Usage Budgets',
    evaluated: true,
    matched: isBudgetExhausted,
    resultAction: isBudgetExhausted ? 'BLOCK' : undefined,
    detail: matchingBudget
      ? `Budget for '${matchingBudget.target}': ${Math.round(
          simulatedUsageSeconds / 60
        )} / ${Math.round(
          (matchingBudget.dailyLimitSeconds + (matchingBudget.bonusSeconds || 0)) / 60
        )} min`
      : 'No quota configured',
  });

  if (isBudgetExhausted && matchingBudget) {
    return {
      action: 'BLOCK',
      matchedRuleType: 'USAGE_LIMIT_EXHAUSTED',
      matchedDomain: matchingBudget.target,
      policyVersion: policy.version,
      reason: `Daily screen-time limit of ${Math.round(
        matchingBudget.dailyLimitSeconds / 60
      )} minutes reached for '${matchingBudget.target}'`,
      evaluationTrace: trace,
    };
  }

  // Level 4: Temporary Grants
  const tempAllowRule = policy.rules.find((r) => {
    if (r.action !== 'TEMPORARY_ALLOW') return false;
    if (!domainMatches(normDomain, r.domain)) return false;
    if (!r.expiresAt) return false;
    return currentTime < new Date(r.expiresAt);
  });
  trace.push({
    level: '4. Temporary Parental Grant',
    evaluated: true,
    matched: Boolean(tempAllowRule),
    resultAction: tempAllowRule ? 'ALLOW' : undefined,
    detail: tempAllowRule
      ? `Active grant until ${new Date(tempAllowRule.expiresAt!).toLocaleTimeString()}`
      : 'No active temporary grant',
  });
  if (tempAllowRule) {
    return {
      action: 'ALLOW',
      matchedRuleType: 'TEMPORARY_GRANT',
      matchedRuleId: tempAllowRule.id,
      matchedDomain: tempAllowRule.domain,
      policyVersion: policy.version,
      expiresAt: tempAllowRule.expiresAt,
      reason: `Parent temporarily approved access until ${new Date(tempAllowRule.expiresAt!).toLocaleTimeString()}.`,
      evaluationTrace: trace,
    };
  }

  // Level 5: Explicit Whitelist
  const explicitAllowRule = policy.rules.find(
    (r) => r.action === 'ALLOW' && domainMatches(normDomain, r.domain)
  );
  trace.push({
    level: '5. Explicit Website Whitelist',
    evaluated: true,
    matched: Boolean(explicitAllowRule),
    resultAction: explicitAllowRule ? 'ALLOW' : undefined,
    detail: explicitAllowRule ? `Matched custom rule: ${explicitAllowRule.domain}` : 'No explicit allow rule',
  });
  if (explicitAllowRule) {
    return {
      action: 'ALLOW',
      matchedRuleType: 'EXPLICIT_ALLOW',
      matchedRuleId: explicitAllowRule.id,
      matchedDomain: explicitAllowRule.domain,
      policyVersion: policy.version,
      reason: `Explicitly allowed by parent rule for '${explicitAllowRule.domain}'.`,
      evaluationTrace: trace,
    };
  }

  // Level 6: Explicit Blacklist
  const explicitBlockRule = policy.rules.find(
    (r) => r.action === 'BLOCK' && domainMatches(normDomain, r.domain)
  );
  trace.push({
    level: '6. Explicit Website Blacklist',
    evaluated: true,
    matched: Boolean(explicitBlockRule),
    resultAction: explicitBlockRule ? 'BLOCK' : undefined,
    detail: explicitBlockRule ? `Matched custom block rule: ${explicitBlockRule.domain}` : 'No explicit block rule',
  });
  if (explicitBlockRule) {
    return {
      action: 'BLOCK',
      matchedRuleType: 'EXPLICIT_BLOCK',
      matchedRuleId: explicitBlockRule.id,
      matchedDomain: explicitBlockRule.domain,
      policyVersion: policy.version,
      reason: `Explicitly blocked by parent rule: ${explicitBlockRule.domain}${
        explicitBlockRule.reason ? ` (${explicitBlockRule.reason})` : ''
      }.`,
      evaluationTrace: trace,
    };
  }

  // Level 7: Study Mode
  const isStudyModeActive = Boolean(policy.studyMode?.active);
  const isStudyAllowed = detectedCategory === 'EDUCATION';
  trace.push({
    level: '7. Study Mode Routine',
    evaluated: isStudyModeActive,
    matched: isStudyModeActive && !isStudyAllowed,
    resultAction: isStudyModeActive && !isStudyAllowed ? 'BLOCK' : undefined,
    detail: isStudyModeActive
      ? isStudyAllowed
        ? 'Allowed (Category: EDUCATION)'
        : 'Blocked (Non-educational category)'
      : 'Study Mode Inactive',
  });
  if (isStudyModeActive && !isStudyAllowed) {
    return {
      action: 'BLOCK',
      matchedRuleType: 'STUDY_MODE',
      policyVersion: policy.version,
      reason: 'Study Mode is active. Only educational websites are permitted.',
      evaluationTrace: trace,
    };
  }

  // Level 8: Bedtime Routine
  const isBedtimeConfigured = Boolean(policy.bedtime?.enabled);
  const isCurrentlyBedtime = isBedtimeConfigured && isWithinBedtime(currentTime, policy.bedtime!);
  const isBedtimeAllowed = isCurrentlyBedtime && policy.bedtime?.allowEducationalOnly && detectedCategory === 'EDUCATION';
  trace.push({
    level: '8. Bedtime Routine',
    evaluated: isBedtimeConfigured,
    matched: isCurrentlyBedtime && !isBedtimeAllowed,
    resultAction: isCurrentlyBedtime && !isBedtimeAllowed ? 'BLOCK' : undefined,
    detail: isCurrentlyBedtime
      ? isBedtimeAllowed
        ? 'Allowed (Educational during bedtime)'
        : 'Blocked (Bedtime curfew active)'
      : 'Bedtime Inactive',
  });
  if (isCurrentlyBedtime && !isBedtimeAllowed) {
    return {
      action: 'BLOCK',
      matchedRuleType: 'BEDTIME',
      policyVersion: policy.version,
      reason: 'Bedtime Routine is active. Non-essential websites are locked during night hours.',
      evaluationTrace: trace,
    };
  }

  // Level 9: Category Controls
  const categoryBlocked = Boolean(
    detectedCategory &&
      policy.categoryControls?.some((c) => c.category === detectedCategory && c.action === 'BLOCK')
  );
  trace.push({
    level: '9. Smart Category Filter',
    evaluated: Boolean(detectedCategory),
    matched: categoryBlocked,
    resultAction: categoryBlocked ? 'BLOCK' : undefined,
    detail: detectedCategory
      ? `Category: ${detectedCategory} (Status: ${categoryBlocked ? 'BLOCKED' : 'ALLOWED'})`
      : 'Category: UNCATEGORIZED (Allowed)',
  });
  if (categoryBlocked) {
    return {
      action: 'BLOCK',
      matchedRuleType: 'CATEGORY',
      policyVersion: policy.version,
      reason: `Blocked under content category '${detectedCategory}'.`,
      evaluationTrace: trace,
    };
  }

  // Level 10: Default Allow
  trace.push({
    level: '10. Default Policy',
    evaluated: true,
    matched: true,
    resultAction: 'ALLOW',
    detail: 'Passed all security and routine filters',
  });

  return {
    action: 'ALLOW',
    matchedRuleType: 'DEFAULT',
    policyVersion: policy.version,
    reason: 'Website passed all policy and routine layers.',
    evaluationTrace: trace,
  };
}
