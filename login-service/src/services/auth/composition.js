import { createAuthStateService } from './auth-state-service.js';
import { createSmsAuthService } from './sms-auth-service.js';
import { createCredentialExportService } from './credential-export-service.js';
import { createSessionLogoutService } from './session-logout-service.js';
import { createTotpService } from './totp-service.js';
import { createPlusTrialService } from './plus-trial-service.js';
import { createSessionLoginService } from './session-login-service.js';
import { createSessionHealthRunner } from './session-health-runner.js';
import { createWorkspaceAuthService } from './workspace-auth-service.js';
import { createCodexAuthService } from './codex-auth-service.js';
import { createOpenAIJsonAuthFlow } from './openai-json-auth-flow.js';

/** Compose stateless services in dependency order. Repository proxies and
 * configuration getters resolve the active request when an operation runs.
 * No service here retains an account, a token or a flow between requests.
 */
export function createAuthenticationServices(dependencies) {
  const state = createAuthStateService(dependencies);
  const sms = createSmsAuthService(dependencies);
  const credentials = createCredentialExportService(dependencies);
  const flowDependencies = { ...dependencies, ...state, ...sms, ...credentials };
  const OpenAIJsonAuthFlow = createOpenAIJsonAuthFlow(flowDependencies);
  const sessions = createSessionLoginService({ ...flowDependencies, OpenAIJsonAuthFlow });
  const operations = { ...flowDependencies, ...sessions, OpenAIJsonAuthFlow };

  return {
    ...state,
    ...sms,
    ...credentials,
    ...sessions,
    ...createSessionLogoutService(operations),
    ...createTotpService(operations),
    ...createPlusTrialService(operations),
    ...createSessionHealthRunner(operations),
    ...createWorkspaceAuthService(operations),
    ...createCodexAuthService(operations),
    OpenAIJsonAuthFlow,
  };
}
