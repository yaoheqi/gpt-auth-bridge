import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Sub2ApiPushService } from '../src/services/sub2api-push-service.js';

function exported(rt = 'rt-1', id = 'acc-1') { return { name: `${id}@example.com`, platform: 'openai', type: 'oauth', credentials: { access_token: `access-${id}`, refresh_token: rt, chatgpt_account_id: id, account_id: id, email: `${id}@example.com` } }; }
function configured(fetchImpl) { return { stateDir: '', env: { SUB2API_BASE_URL: 'https://sub2.test', SUB2API_ADMIN_API_KEY: 'key', SUB2API_GROUP_NAME: '1', SUB2API_TARGET: '100' }, fetchImpl, logger: { error() {}, warn() {}, info() {} } }; }

test('disabled push retains nothing', async () => {
  const service = new Sub2ApiPushService({ env: {} });
  assert.deepEqual(await service.enqueueImmediate([exported()]), { enabled: false, queued: 0, imported: 0 });
});

test('push waits for remote completion and never creates a server queue', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2-browser-'));
  try {
    let release;
    let finished = false;
    const service = new Sub2ApiPushService({ ...configured(async () => {
      await new Promise(resolve => { release = resolve; });
      return { ok: true, status: 200, text: async () => JSON.stringify({code: 0, data: {success: 1, failed: 0, results: [{success: true}]}}) };
    }), stateDir: dir });
    const pending = service.enqueueImmediate([exported()]).then(result => { finished = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    assert.deepEqual(await fs.readdir(dir), []);
    release();
    assert.equal((await pending).imported, 1);
    await service.stop();
    assert.equal(service.client, null);
    assert.deepEqual(await fs.readdir(dir), []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('failed push reports failure without retaining accounts or scheduling retry', async () => {
  const service = new Sub2ApiPushService(configured(async () => { throw new Error('network'); }));
  const result = await service.enqueueImmediate([exported()]);
  assert.equal(result.imported, 0);
  assert.match(result.error, /network/);
  assert.equal(result.queueSize, 0);
  assert.doesNotMatch(JSON.stringify(service), /rt-1|access-acc-1/);
  assert.equal(service.timer, undefined);
});

test('push rejects incomplete credentials', async () => {
  const service = new Sub2ApiPushService(configured(async () => { throw new Error('should not call'); }));
  await assert.rejects(() => service.enqueueImmediate([{ platform: 'openai', type: 'oauth', credentials: { refresh_token: 'rt-only' } }]), /access_token/);
});
