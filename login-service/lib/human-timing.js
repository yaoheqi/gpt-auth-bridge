/** Human-like pacing helpers for protocol auth flows. */

export const HUMAN_PAUSE_DEFAULTS = Object.freeze({
  navigate: Object.freeze({ min: 600, max: 1800 }),
  think: Object.freeze({ min: 1200, max: 3500 }),
  type: Object.freeze({ min: 800, max: 2200 }),
  betweenAccounts: Object.freeze({ min: 12_000, max: 35_000 }),
});

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function normalizeHumanTimingSettings(value = {}, defaults = {}) {
  const enabled = value.humanPacingEnabled === false
    || value.human_pacing_enabled === false
    || value.humanPacingEnabled === '0'
    || value.humanPacingEnabled === 0
    ? false
    : value.humanPacingEnabled == null && value.human_pacing_enabled == null
      ? (defaults.humanPacingEnabled !== false)
      : Boolean(value.humanPacingEnabled ?? value.human_pacing_enabled);

  let accountGapMsMin = clampInt(
    value.accountGapMsMin ?? value.account_gap_ms_min,
    0,
    300_000,
    defaults.accountGapMsMin ?? HUMAN_PAUSE_DEFAULTS.betweenAccounts.min,
  );
  let accountGapMsMax = clampInt(
    value.accountGapMsMax ?? value.account_gap_ms_max,
    0,
    300_000,
    defaults.accountGapMsMax ?? HUMAN_PAUSE_DEFAULTS.betweenAccounts.max,
  );
  if (accountGapMsMax < accountGapMsMin) {
    const tmp = accountGapMsMin;
    accountGapMsMin = accountGapMsMax;
    accountGapMsMax = tmp;
  }

  return {
    humanPacingEnabled: enabled,
    accountGapMsMin,
    accountGapMsMax,
  };
}

export function sampleDelayMs(minMs, maxMs) {
  const min = Math.max(0, Number(minMs) || 0);
  const max = Math.max(min, Number(maxMs) || min);
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

export function sampleHumanDelayMs(kind = 'navigate', overrides = {}) {
  const key = String(kind || 'navigate');
  const fallback = HUMAN_PAUSE_DEFAULTS[key] || HUMAN_PAUSE_DEFAULTS.navigate;
  if (key === 'betweenAccounts') {
    return sampleDelayMs(
      overrides.accountGapMsMin ?? fallback.min,
      overrides.accountGapMsMax ?? fallback.max,
    );
  }
  return sampleDelayMs(fallback.min, fallback.max);
}

/**
 * @param {string} kind
 * @param {{ enabled?: boolean, sleep?: (ms:number)=>Promise<void>, accountGapMsMin?: number, accountGapMsMax?: number }} [options]
 */
export async function humanPause(kind = 'navigate', options = {}) {
  if (options.enabled === false) return 0;
  const ms = sampleHumanDelayMs(kind, options);
  if (ms <= 0) return 0;
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (wait) => new Promise((resolve) => setTimeout(resolve, wait));
  await sleep(ms);
  return ms;
}
