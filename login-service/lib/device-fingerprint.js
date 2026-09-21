const DEFAULT_CHROME_MAJOR = '146';
const DEFAULT_UA_TEMPLATE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const VIEWPORTS = [
  [1280, 720],
  [1366, 768],
  [1440, 900],
  [1536, 864],
  [1600, 900],
  [1680, 1050],
  [1920, 1080],
  [2560, 1440],
];

const GPU_PROFILES = [
  ['Intel Inc.', 'Intel(R) UHD Graphics 620'],
  ['Intel Inc.', 'Intel(R) Iris(R) Xe Graphics'],
  ['Intel Inc.', 'Intel(R) UHD Graphics 770'],
  ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
];

const FONT_POOLS = [
  ['Arial', 'Calibri', 'Cambria', 'Candara', 'Consolas', 'Segoe UI', 'Times New Roman'],
  ['Arial', 'Calibri', 'Corbel', 'Georgia', 'Segoe UI', 'Tahoma', 'Verdana'],
  ['Arial', 'Cambria', 'Consolas', 'Courier New', 'Segoe UI', 'Trebuchet MS', 'Verdana'],
  ['Arial', 'Calibri', 'Microsoft Sans Serif', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Verdana'],
];

export const FINGERPRINT_REGION_PROFILES = Object.freeze({
  US: {
    label: '美国 en-US',
    locale: 'en-US',
    languageFallback: 'en',
    timezones: ['America/New_York', 'America/Chicago', 'America/Los_Angeles'],
  },
  GB: {
    label: '英国 en-GB',
    locale: 'en-GB',
    languageFallback: 'en',
    timezones: ['Europe/London'],
  },
  CA: {
    label: '加拿大 en-CA',
    locale: 'en-CA',
    languageFallback: 'en',
    timezones: ['America/Toronto', 'America/Vancouver'],
  },
  AU: {
    label: '澳大利亚 en-AU',
    locale: 'en-AU',
    languageFallback: 'en',
    timezones: ['Australia/Sydney', 'Australia/Melbourne'],
  },
  DE: {
    label: '德国 de-DE',
    locale: 'de-DE',
    languageFallback: 'de',
    timezones: ['Europe/Berlin'],
  },
  FR: {
    label: '法国 fr-FR',
    locale: 'fr-FR',
    languageFallback: 'fr',
    timezones: ['Europe/Paris'],
  },
  NL: {
    label: '荷兰 nl-NL',
    locale: 'nl-NL',
    languageFallback: 'nl',
    timezones: ['Europe/Amsterdam'],
  },
  SG: {
    label: '新加坡 en-SG',
    locale: 'en-SG',
    languageFallback: 'en',
    timezones: ['Asia/Singapore'],
  },
  JP: {
    label: '日本 ja-JP',
    locale: 'ja-JP',
    languageFallback: 'ja',
    timezones: ['Asia/Tokyo'],
  },
});

export const FINGERPRINT_REGIONS = Object.freeze(Object.keys(FINGERPRINT_REGION_PROFILES));

export function mapCountryCodeToFingerprintRegion(value) {
  const code = String(value || '').trim().toUpperCase();
  if (FINGERPRINT_REGION_PROFILES[code]) return code;
  const aliases = {
    UK: 'GB',
    IE: 'GB',
    AT: 'DE',
    CH: 'DE',
    BE: 'NL',
    MY: 'SG',
    HK: 'SG',
    KR: 'JP',
  };
  return aliases[code] || 'US';
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function randomPick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

export function normalizeFingerprintRegion(value) {
  const region = String(value || '').trim().toUpperCase();
  return FINGERPRINT_REGION_PROFILES[region] ? region : 'US';
}

export function normalizeFingerprintRegionSetting(value) {
  const region = String(value || '').trim().toUpperCase();
  if (region === 'AUTO') return 'AUTO';
  return normalizeFingerprintRegion(region);
}

/**
 * Align with app.py generate_fingerprint(region).
 * @param {string} [region]
 */
export function generateFingerprint(region = 'US') {
  const chromeMajor = DEFAULT_CHROME_MAJOR;
  const chromeFull = `${chromeMajor}.0.${randomInt(7200, 7400)}.${randomInt(20, 160)}`;
  const [width, height] = randomPick(VIEWPORTS);
  const normalizedRegion = normalizeFingerprintRegion(region);
  const profile = FINGERPRINT_REGION_PROFILES[normalizedRegion] || FINGERPRINT_REGION_PROFILES.US;
  const locale = profile.locale;
  const timezoneId = randomPick(profile.timezones);
  const userAgent = DEFAULT_UA_TEMPLATE.replace('146.0.0.0', chromeFull);
  const hardwareConcurrency = randomPick([4, 6, 8, 12, 16]);
  const deviceMemory = randomPick([4, 8, 16]);
  const platformVersion = randomPick(['10.0.0', '14.0.0', '15.0.0']);
  const [webglVendor, webglRenderer] = randomPick(GPU_PROFILES);
  const colorDepth = randomPick([24, 30]);
  const canvasSeed = randomInt(0, 0xffffffff).toString(16).padStart(8, '0');
  const audioSeed = randomInt(1, 9) / 1_000_000;
  const mediaId = randomInt(0, 0xffffffff).toString(16).padStart(8, '0');
  const connectionEffectiveType = randomPick(['4g', '4g', '4g', '3g']);
  const connectionDownlink = connectionEffectiveType === '4g'
    ? Math.round((6 + Math.random() * 79) * 10) / 10
    : Math.round((1.2 + Math.random() * 6.8) * 10) / 10;
  const connectionRtt = connectionEffectiveType === '4g'
    ? randomPick([25, 50, 75, 100, 125])
    : randomPick([150, 200, 250]);
  const languages = [...new Set([locale, profile.languageFallback, 'en'])];
  const acceptLanguage = profile.languageFallback === 'en'
    ? `${locale},en;q=0.9`
    : `${locale},${profile.languageFallback};q=0.9,en;q=0.8`;

  return {
    userAgent,
    chromeMajor,
    chromeFull,
    platform: 'Win32',
    vendor: 'Google Inc.',
    locale,
    acceptLanguage,
    languages,
    timezoneId,
    viewportWidth: width,
    viewportHeight: height,
    screenWidth: width,
    screenHeight: height,
    outerWidth: width,
    outerHeight: height + randomPick([72, 80, 88, 96]),
    deviceScaleFactor: randomPick([1, 1.25, 1.5]),
    hardwareConcurrency,
    deviceMemory,
    jsHeapSizeLimit: 4294967296,
    maxTouchPoints: 0,
    hasTouch: false,
    isMobile: false,
    colorDepth,
    pixelDepth: colorDepth,
    webglVendor,
    webglRenderer,
    canvasSeed,
    audioSeed,
    doNotTrack: randomPick(['unspecified', '0']),
    connectionEffectiveType,
    connectionDownlink,
    connectionRtt,
    connectionSaveData: false,
    batteryLevel: Math.round((0.42 + Math.random() * 0.56) * 100) / 100,
    batteryCharging: randomPick([true, false]),
    mediaDevices: [
      { kind: 'audioinput', label: 'Microphone Array (Realtek(R) Audio)', deviceId: `audioin-${mediaId}` },
      { kind: 'audiooutput', label: 'Speakers (Realtek(R) Audio)', deviceId: `audioout-${mediaId}` },
      { kind: 'videoinput', label: randomPick(['Integrated Camera', 'HD Webcam', 'USB2.0 HD UVC WebCam']), deviceId: `videoin-${mediaId}` },
    ],
    fonts: randomPick(FONT_POOLS),
    pdfViewerEnabled: true,
    clientHints: {
      secChUa: `"Google Chrome";v="${chromeMajor}", "Chromium";v="${chromeMajor}", "Not.A/Brand";v="24"`,
      secChUaFullVersionList:
        `"Google Chrome";v="${chromeFull}", "Chromium";v="${chromeFull}", "Not.A/Brand";v="24.0.0.0"`,
      secChUaMobile: '?0',
      secChUaPlatform: '"Windows"',
      secChUaPlatformVersion: `"${platformVersion}"`,
      secChViewportWidth: `"${width}"`,
    },
    region: normalizedRegion,
  };
}

export function parseFingerprintJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function buildBrowserHeadersFromFingerprint(fingerprint, init = {}) {
  const fp = fingerprint || generateFingerprint();
  const hints = fp.clientHints || {};
  const base = {
    'user-agent': fp.userAgent,
    'accept-language': fp.acceptLanguage,
    'sec-ch-ua': hints.secChUa,
    'sec-ch-ua-full-version-list': hints.secChUaFullVersionList,
    'sec-ch-ua-mobile': hints.secChUaMobile,
    'sec-ch-ua-platform': hints.secChUaPlatform,
    'sec-ch-ua-platform-version': hints.secChUaPlatformVersion,
    'sec-ch-viewport-width': hints.secChViewportWidth,
  };
  // Only fill sec-fetch defaults when caller did not set them (document navigations usually do).
  if (init['sec-fetch-dest'] == null && init['sec-fetch-mode'] == null) {
    base['sec-fetch-dest'] = 'empty';
    base['sec-fetch-mode'] = 'cors';
    base['sec-fetch-site'] = 'same-origin';
  }
  return {
    ...base,
    ...init,
  };
}

export function summarizeFingerprint(fingerprint) {
  if (!fingerprint) return 'default';
  return [
    fingerprint.region || 'US',
    `Chrome/${fingerprint.chromeFull || fingerprint.chromeMajor || '?'}`,
    `${fingerprint.viewportWidth || '?'}x${fingerprint.viewportHeight || '?'}`,
    `cores=${fingerprint.hardwareConcurrency || '?'}`,
    fingerprint.timezoneId || '',
  ].filter(Boolean).join(' · ');
}
