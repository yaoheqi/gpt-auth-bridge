import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeLogMessage } from './log-sanitize.js';

test('Chinese punctuation terminates URLs while credentials and queries remain hidden', () => {
  assert.equal(sanitizeLogMessage('出口=http://user:secret@proxy.example:3000/，目标=auth.openai.com'),
    '出口=http://proxy.example:3000/，目标=auth.openai.com');
  assert.equal(sanitizeLogMessage('OAuth：https://auth.openai.com/consent?code=private。继续'),
    'OAuth：https://auth.openai.com/consent。继续');
});

test('cookie scope diagnostics remain readable while account emails are redacted', () => {
  const result = sanitizeLogMessage('oai-client-auth-session [domain=auth.openai.com path=/] fixture@example.com');
  assert.match(result, /oai-client-auth-session \[domain=auth\.openai\.com path=\/\]/);
  assert.doesNotMatch(result, /fixture/);
});
