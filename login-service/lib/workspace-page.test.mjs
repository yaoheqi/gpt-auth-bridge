import assert from 'node:assert/strict';
import test from 'node:test';
import { readWorkspacePagePayload } from './workspace-page.js';

// Same reference-table structure observed in the consent page; synthetic data.
const table = [
  { _1: 2 }, 'loaderData', { _3: 4 }, 'routes/layouts/client-auth-session-layout/layout',
  { _5: 6 }, 'clientAuthSession', { _7: 8 }, 'workspaces', [9, 16],
  { _10: 11, _12: 13, _14: 15 }, 'id', 'business-id', 'name', 'private workspace name', 'kind', 'organization',
  { _10: 17, _14: 18 }, 'personal-id', 'personal',
];
const expected = { workspaces: [{ id: 'business-id', kind: 'organization' }, { id: 'personal-id', kind: 'personal' }] };
const streamScript = text => `<script nonce="fixture">window.__reactRouterContext.streamController.enqueue(${JSON.stringify(text)});</script>`;

test('reads consent loader workspaces without evaluating scripts or retaining private fields', () => {
  const html = '<script>throw new Error("must not run")</script>' + streamScript(JSON.stringify(table) + '\n');
  assert.deepEqual(readWorkspacePagePayload(html), expected);
  assert.doesNotMatch(JSON.stringify(readWorkspacePagePayload(html)), /private|clientAuthSession/);
});

test('assembles streamed JSON across script chunks before decoding references', () => {
  const data = JSON.stringify(table) + '\n';
  const split = 81;
  assert.deepEqual(readWorkspacePagePayload(streamScript(data.slice(0, split)) + streamScript(data.slice(split))), expected);
});

test('reads JSON loader payloads and deduplicates matching catalogs', () => {
  const html = `<script type="application/json">${JSON.stringify({ loaderData: { auth: expected } })}</script>`;
  assert.deepEqual(readWorkspacePagePayload(html + streamScript(JSON.stringify(table))), expected);
});

test('missing data returns no catalog; malformed, conflicting or oversized data fails without leaking it', () => {
  assert.equal(readWorkspacePagePayload('<html>consent</html>'), null);
  assert.equal(readWorkspacePagePayload(streamScript('P1:unrelated promise frame\n')), null);
  for (const transform of [
    value => { value[8] = 'private invalid list'; },
    value => { value[8] = [9999]; },
    value => { value[9]._10 = -5; },
    value => { value[16]._10 = 11; },
  ]) {
    const changed = structuredClone(table);
    transform(changed);
    assert.throws(() => readWorkspacePagePayload(streamScript(JSON.stringify(changed))), error => {
      assert.equal(error.code, 'WORKSPACE_PAGE_INVALID');
      assert.doesNotMatch(error.message, /private|business-id|personal-id/);
      return true;
    });
  }
  const conflict = `<script type="application/json">${JSON.stringify({ workspaces: [] })}</script>`;
  assert.throws(() => readWorkspacePagePayload(conflict + streamScript(JSON.stringify(table))), { code: 'WORKSPACE_PAGE_INVALID' });
  assert.throws(() => readWorkspacePagePayload(' '.repeat(2 * 1024 * 1024 + 1)), { code: 'WORKSPACE_PAGE_INVALID' });
});
