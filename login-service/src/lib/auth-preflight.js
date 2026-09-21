import { hasTotpSecret, validateTotpSecret } from '../../lib/totp.js';
import { protocolLoginCredentialIssue } from '../domain/accounts/account-domain.js';
import { AUTH_FAILURE_CATEGORIES } from './auth-failure-classifier.js';

function issue(accountId, email, code, message, severity = 'error') {
  return { accountId: String(accountId || ''), email: String(email || ''), code, message, severity };
}

export function preflightAccountForAuth(account = {}, { mode = 'protocol-login', egress = {}, strictEgress = false } = {}) {
  const issues = [];
  const email = account.email || '';
  if (!String(email).includes('@')) issues.push(issue(account.id, email, AUTH_FAILURE_CATEGORIES.CREDENTIAL_MISSING, '缺少有效邮箱'));
  if (mode === 'register') {
    if (!String(account.openai_password || account.password || '').trim()) issues.push(issue(account.id, email, AUTH_FAILURE_CATEGORIES.CREDENTIAL_MISSING, '缺少注册/登录密码'));
  }
  if (mode === 'protocol-login') {
    const credentialIssue = protocolLoginCredentialIssue(account);
    if (credentialIssue) issues.push(issue(account.id, email, AUTH_FAILURE_CATEGORIES.CREDENTIAL_MISSING, credentialIssue));
  }
  if (mode !== 'protocol-login' && hasTotpSecret(account)) {
    try { validateTotpSecret(account.two_factor_secret); } catch (error) { issues.push(issue(account.id, email, AUTH_FAILURE_CATEGORIES.CREDENTIAL_MISSING, error instanceof Error ? error.message : String(error))); }
  }
  const expected = String(account.egress_country || '').toUpperCase();
  const actual = String(egress.countryCode || egress.egress_country || '').toUpperCase();
  if (expected && actual && expected !== actual) {
    issues.push(issue(account.id, email, AUTH_FAILURE_CATEGORIES.EGRESS_BLOCKED, `出口地区不一致：账号绑定=${expected} 当前=${actual}`, strictEgress ? 'error' : 'warn'));
  }
  const blocking = issues.filter((item) => item.severity === 'error');
  return { ok: blocking.length === 0, issues, blocking, warnings: issues.filter((item) => item.severity === 'warn') };
}

export function preflightAccountsForAuth(accounts = [], options = {}) {
  const rows = accounts.map((account) => ({ accountId: account.id, email: account.email, ...preflightAccountForAuth(account, options) }));
  return {
    ok: rows.every((row) => row.ok),
    total: rows.length,
    passed: rows.filter((row) => row.ok).length,
    failed: rows.filter((row) => !row.ok).length,
    warnings: rows.reduce((sum, row) => sum + row.warnings.length, 0),
    rows,
  };
}
