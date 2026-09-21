import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBusinessWorkspaceIds, resolveBusinessWorkspaceId, extractBusinessWorkspaceIds, extractSessionAccessToken, resolveWorkspaceSelection, validateBusinessAuthRecord } from './business-workspace.js';

test('workspace config dedupes and follows precedence', () => {
  assert.deepEqual(normalizeBusinessWorkspaceIds(' a, b\na '), ['a','b']);
  assert.equal(resolveBusinessWorkspaceId({ requestWorkspaceIds:['request'], accountWorkspaceId:'stored', appWorkspaceIds:['app'], envWorkspaceIds:'env' }), 'request');
  assert.equal(resolveBusinessWorkspaceId({ accountWorkspaceId:'stored', appWorkspaceIds:['app'] }), 'stored');
  assert.equal(resolveBusinessWorkspaceId({ appWorkspaceIds:['app'], envWorkspaceIds:'env' }), 'app');
});

test('extractSessionAccessToken reads nested session json', () => {
  assert.equal(extractSessionAccessToken({session_json:'{"accessToken":"inside"}'}), 'inside');
  assert.equal(extractSessionAccessToken({session_access_token:'direct'}), 'direct');
});

test('extractBusinessWorkspaceIds reads all non-personal workspaces from stored session cookie', () => {
  const payload = { workspaces: [{ id: 'personal', kind: 'personal' }, { id: 'org-a', kind: 'organization' }, { id: 'org-b', type: 'workspace' }, { id: 'org-a', kind: 'organization' }] };
  const value = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const account = { storage_state_json: JSON.stringify({ cookies: [{ name: 'oai-client-auth-session', value: `${value}.signature` }] }) };
  assert.deepEqual(extractBusinessWorkspaceIds(account), ['org-a', 'org-b']);
});


test('explicit workspace selection exact-matches and never falls back', () => {
  const payload={workspaces:[{id:'personal',kind:'personal'},{id:'business',kind:'business'}]};
  assert.equal(resolveWorkspaceSelection(payload,{mode:'personal'}),'personal');
  assert.equal(resolveWorkspaceSelection(payload,{mode:'id',workspaceId:'business'}),'business');
  assert.throws(()=>resolveWorkspaceSelection(payload,{mode:'id',workspaceId:'missing'}),error=>error.code==='BUSINESS_NOT_MEMBER');
});


test('Business auth validation requires matching workspace and refresh token', () => {
  const exp=Math.floor(Date.now()/1000)+3600;
  const token=`x.${Buffer.from(JSON.stringify({exp,client_id:'codex-client','https://api.openai.com/auth':{chatgpt_account_id:'ws-1'}})).toString('base64url')}.x`;
  assert.equal(validateBusinessAuthRecord({access_token:token,refresh_token:'rt',account_id:'ws-1'},'ws-1').accountId,'ws-1');
  assert.throws(()=>validateBusinessAuthRecord({access_token:token,refresh_token:'rt'},'ws-2'),/不匹配/);
  assert.throws(()=>validateBusinessAuthRecord({access_token:token},'ws-1'),/refresh_token/);
});
