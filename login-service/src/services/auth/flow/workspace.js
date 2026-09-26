import {
  AUTH_BASE_URL as defaultAUTH_BASE_URL,
  AUTH_WORKSPACE_SELECT_URL as defaultAUTH_WORKSPACE_SELECT_URL,
  normalizeAuthContinueUrl as defaultNormalizeAuthContinueUrl,
} from '../../../../lib/openai-auth-urls.js';
import { OPENAI_CODEX_REDIRECT_URI as defaultOPENAI_CODEX_REDIRECT_URI } from '../../../../lib/openai-oauth.js';
import { firstNonEmpty as defaultFirstNonEmpty } from '../../../../lib/jwt-utils.js';
import { openOAuthPage as defaultOpenOAuthPage } from '../../../../lib/oauth-navigation.js';
import { readWorkspacePagePayload as defaultReadWorkspacePagePayload } from '../../../../lib/workspace-page.js';
import {
  readWorkspaceSessionPayload as defaultReadWorkspaceSessionPayload,
  resolveWorkspaceSelection as defaultResolveWorkspaceSelection,
} from '../../../../lib/business-workspace.js';
import { registerOpenAIAgentIdentity as defaultRegisterOpenAIAgentIdentity } from '../../../../lib/openai-agent-identity.js';

/** Request-owned operations. Configuration and repositories are supplied by the composition root. */
export function createWorkspaceMethods({
  AUTH_BASE_URL = defaultAUTH_BASE_URL,
  AUTH_WORKSPACE_SELECT_URL = defaultAUTH_WORKSPACE_SELECT_URL,
  OPENAI_CODEX_REDIRECT_URI = defaultOPENAI_CODEX_REDIRECT_URI,
  firstNonEmpty = defaultFirstNonEmpty,
  normalizeAuthContinueUrl = defaultNormalizeAuthContinueUrl,
  openOAuthPage = defaultOpenOAuthPage,
  persistAgentIdentity,
  readWorkspacePagePayload = defaultReadWorkspacePagePayload,
  readWorkspaceSessionPayload = defaultReadWorkspaceSessionPayload,
  registerOpenAIAgentIdentity = defaultRegisterOpenAIAgentIdentity,
  resolveWorkspaceSelection = defaultResolveWorkspaceSelection,
  sleep,
} = {}) {
  return {
    async resolveWorkspaceID(consentHtml = '') {
      const pagePayload = readWorkspacePagePayload(consentHtml);
      if (pagePayload) {
        this.discoveredWorkspaces = pagePayload.workspaces;
        this.log(`已从授权页读取 ${pagePayload.workspaces.length} 个工作区`);
        return resolveWorkspaceSelection(pagePayload, this.workspaceSelection);
      }
      // Do not maintain a fixed list of OpenAI hosts here. The auth service has
      // used auth.openai.com, child.auth.openai.com and other subdomains over
      // time, and the cookie may be scoped to a non-root consent/API path. A
      // serialized jar enumerates every domain/path (including host-only
      // cookies) without making a value-bearing request to a guessed origin.
      const state = await this.jar.serialize();
      const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
      try {
        const payload = readWorkspaceSessionPayload(cookies);
        this.discoveredWorkspaces = payload.workspaces;
        return resolveWorkspaceSelection(payload, this.workspaceSelection);
      } catch (error) {
        const details = cookies
          .map(cookie => `${cookie.name || cookie.key} [domain=${cookie.domain || '(host)'} path=${cookie.path || '/'}]`)
          .filter(Boolean)
          .slice(0, 40)
          .join(', ');
        this.log(`工作区 Cookie 诊断: count=${cookies.length}${details ? `; ${details}` : '; none'}`, 'warn');
        throw error;
      }
    },

    async selectWorkspace(consentURL) {
      const { url: landedUrl, response: consentResponse } = await openOAuthPage(this.fetch, consentURL, {
        callbackUrl: OPENAI_CODEX_REDIRECT_URI,
        headers: this.browserHeaders({
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          referer: consentURL,
        }),
      });
      // Consent can redirect to a callback, phone challenge or renewed login.
      // Let the state machine process the actual step before demanding a cookie.
      if (!this.isConsentUrl(landedUrl)) {
        if (!landedUrl.startsWith(OPENAI_CODEX_REDIRECT_URI) && !this.isAuthStartUrl(landedUrl)) {
          throw new Error(`工作区授权跳转到未知路径: ${this.pathOf(landedUrl)}`);
        }
        this.log(`工作区授权跳转到: ${this.pathOf(landedUrl)}`);
        return landedUrl;
      }
      this.log(`工作区授权页: HTTP ${consentResponse.status} path=${this.pathOf(landedUrl)}`);
      const workspaceID = await this.resolveWorkspaceID(await consentResponse.text());
      const response = await this.fetch(AUTH_WORKSPACE_SELECT_URL, {
        method: 'POST',
        redirect: 'manual',
        headers: this.browserHeaders({
          accept: 'application/json',
          'content-type': 'application/json',
          origin: AUTH_BASE_URL,
          referer: landedUrl,
        }),
        body: JSON.stringify({ workspace_id: workspaceID }),
      });
      const location = response.headers.get('location');
      if ([301, 302, 303, 307, 308].includes(response.status) && location) {
        return new URL(location, AUTH_WORKSPACE_SELECT_URL).toString();
      }
      if (!response.ok) throw new Error(`WorkspaceSelect请求失败: ${await this.formatErrorResponse(response)}`);
      const payload = await response.json();
      const continueUrl = normalizeAuthContinueUrl(payload.continue_url);
      if (!continueUrl) throw new Error('WorkspaceSelect 响应缺少 continue_url');
      return continueUrl;
    },

    async registerAgentIdentityFromWebSession() {
      if (!this.agentIdentityEnabled) throw new Error('当前为 Codex 登录接码模式，无法跳过手机验证；如需跳过请选择 Agent Identity 转换');
      this.log('遇到手机验证，切换 Agent Identity 模式并跳过短信接码');
      let lastError = 'Web Session 中无 accessToken';
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await this.fetch('https://chatgpt.com/', {
            headers: this.browserHeaders({ accept: 'text/html,*/*' }),
          });
          const response = await this.fetch('https://chatgpt.com/api/auth/session', {
            headers: this.browserHeaders({
              accept: 'application/json',
              referer: 'https://chatgpt.com/',
            }),
          });
          const text = await response.text();
          let session = {};
          try { session = text ? JSON.parse(text) : {}; } catch {}
          const accessToken = firstNonEmpty(session.accessToken, session.access_token, session.token);
          if (!response.ok || !accessToken) {
            lastError = `HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ''}`;
          } else {
            const identity = await registerOpenAIAgentIdentity({
              accessToken,
              email: this.account.email,
              fetchImpl: this.fetch,
            });
            await persistAgentIdentity(this.account.id, identity);
            this.log(`Agent Identity 注册成功: ${identity.agent_runtime_id}`);
            return identity;
          }
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        if (attempt < 3) await sleep(1000);
      }
      throw new Error(`跳过短信接码失败: ${lastError}`);
    },
  };
}
