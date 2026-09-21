import { createHmac, randomBytes } from 'node:crypto';

export function terminalLoginFailure(input = '') {
  const text = (typeof input === 'string' ? input : `${input?.code || ''} ${input?.message || input?.error || ''}`).toLowerCase();
  if (/account[_ -]?(?:deactivated|deleted|not_found)|user[_ -]?(?:deleted|not_found)|account (?:has been |is )?(?:deleted|deactivated)|账号.{0,8}(?:停用|封禁|删除|不存在)|账户.{0,8}(?:删除|停用|不存在)/.test(text)) return 'account_unavailable';
  if (/invalid_username_or_password|(?:incorrect|wrong|invalid)[_ ](?:(?:email(?: address)?|username)[_ ]or[_ ])?password\b|password(?: (?:is|was|has been))?[_ ](?:incorrect|wrong|invalid|rejected)\b|密码.{0,12}(?:错误|不正确|无效|拒绝)/.test(text)) return 'password_invalid';
  if (/(?:invalid|incorrect|wrong)[_ ](?:otp|totp|mfa|2fa)\b|(?:totp|otp|2fa|authenticator)(?:[_ ](?:code|secret))?(?: (?:is|was))?[_ ](?:invalid|incorrect|wrong|rejected)\b|(?:totp|2fa|mfa|验证码).{0,20}(?:错误|不正确|无效|不是有效)|2fa 密钥不能为空/.test(text)
    || (/(?:totp|otp|2fa|mfa|authenticator)/.test(text) && /(?:invalid|incorrect|wrong)[_ ](?:verification |authentication )?code\b|code (?:is )?(?:invalid|incorrect|wrong)\b/.test(text))) return 'totp_invalid';
  return '';
}

// This single-process coordinator retains only salted digests and expiring metadata.
// No account, token, password, TOTP, URL or push key is retained across requests.
export function createMonitorCoordinator({ now = Date.now, ttlMs = 180_000, terminalTtlMs = 86_400_000, maxEntries = 20_000 } = {}) {
  const salt = randomBytes(32);
  const leases = new Map();
  const terminal = new Map();
  const digest = value => createHmac('sha256', salt).update(value).digest('hex');
  const keyFor = email => digest(String(email || '').trim().toLowerCase());
  const versionFor = account => digest(JSON.stringify([String(account.email || '').trim().toLowerCase(), account.openai_password || account.password || '', account.two_factor_secret || account.twoFactorSecret || '']));
  const ownerKey = owner => {
    if (!/^[a-z0-9-]{32,80}$/i.test(String(owner || ''))) throw new Error('测活租约标识无效');
    return digest(owner);
  };
  let sweptAt = -Infinity;
  function sweep() {
    if (now() - sweptAt < 60_000) return;
    sweptAt = now();
    for (const [key, lease] of leases) if (!lease.active && lease.until <= now()) leases.delete(key);
    for (const [key, result] of terminal) if (result.until <= now()) terminal.delete(key);
  }
  function stopReason(account) {
    const entry = terminal.get(versionFor(account));
    return entry?.until > now() ? entry.reason : '';
  }
  return {
    ttlMs,
    async runExclusive(email, work) {
      sweep();
      const key = keyFor(email);
      const current = leases.get(key);
      if (current?.active) throw Object.assign(new Error('该账号正在执行测活、登录、退出会话、自踢或重设 2FA，请稍后重试'), { code: 'ACCOUNT_BUSY' });
      if (!current && leases.size >= maxEntries) throw new Error('账号协调队列已满，请稍后重试');
      const lease = { owner: digest(randomBytes(32).toString('hex')), until: now() + ttlMs, active: 1, released: false };
      leases.set(key, lease);
      try { return await work(); }
      finally { if (leases.get(key) === lease) leases.delete(key); }
    },
    claim(accounts, owner) {
      sweep();
      const holder = ownerKey(owner);
      return accounts.map(account => {
        const key = keyFor(account.email);
        const stop = stopReason(account);
        if (stop) return { id: account.id, owned: false, terminalReason: stop };
        const lease = leases.get(key);
        if ((lease?.active && lease.released) || (lease && lease.owner !== holder && (lease.active || lease.until > now())) || (!lease && leases.size >= maxEntries)) return { id: account.id, owned: false };
        if (lease?.owner === holder) { lease.until = now() + ttlMs; lease.released = false; }
        else leases.set(key, { owner: holder, until: now() + ttlMs, active: 0, released: false });
        return { id: account.id, owned: true };
      });
    },
    release(accounts, owner) {
      const holder = ownerKey(owner);
      for (const account of accounts) {
        const key = keyFor(account.email), lease = leases.get(key);
        if (lease?.owner !== holder) continue;
        if (lease.active) { lease.released = true; lease.until = 0; }
        else leases.delete(key);
      }
    },
    async run(emails, owner, work) {
      const holder = ownerKey(owner);
      const selected = [...new Set(emails.map(keyFor))].map(key => [key, leases.get(key)]);
      if (!selected.length || selected.some(([, lease]) => !lease || lease.owner !== holder || lease.released || lease.active || lease.until <= now())) {
        throw Object.assign(new Error('账号由其他浏览器负责或租约已过期，本轮已跳过'), { code: 'MONITOR_LEASE_LOST' });
      }
      for (const [, lease] of selected) { lease.active++; lease.until = now() + ttlMs; }
      try { return await work(); }
      finally {
        for (const [key, lease] of selected) {
          lease.active--;
          if (lease.released) leases.delete(key);
          else lease.until = now() + ttlMs;
        }
      }
    },
    record(account, reason) {
      const key = versionFor(account);
      if (!reason) { terminal.delete(key); return; }
      if (!['account_unavailable', 'password_invalid', 'totp_invalid', 'sessions_logged_out'].includes(reason)) return;
      sweep();
      if (terminal.size >= maxEntries) terminal.delete(terminal.keys().next().value);
      terminal.set(key, { reason, until: now() + terminalTtlMs });
    },
    stopReason,
  };
}

export const monitorCoordinator = createMonitorCoordinator();
