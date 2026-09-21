/**
 * Provider ports — application services depend on these, not concrete vendors.
 */

export class AuthExecutorPort {
  async register(_account, _options) { throw new Error('not implemented'); }
  async login(_account, _options) { throw new Error('not implemented'); }
}

export class CredentialIssuerPort {
  async issueRefreshToken(_account, _options) { throw new Error('not implemented'); }
  async issueAgentIdentity(_account, _options) { throw new Error('not implemented'); }
}

export class SmsProviderPort {
  async acquireNumber(_account, _options) { throw new Error('not implemented'); }
  async waitForCode(_activation, _options) { throw new Error('not implemented'); }
  async cancel(_activation) { throw new Error('not implemented'); }
}

/** Browser worker adapter port — Python child process executes headed Chromium. */
export function createBrowserWorkerAdapter({ spawnWorker }) {
  return {
    async register(account, options) {
      return spawnWorker({ mode: 'register', account, options });
    },
    async login(account, options) {
      return spawnWorker({ mode: 'login', account, options });
    },
  };
}

/** Protocol auth adapter wrapping existing OpenAI HTTP flow entrypoints. */
export function createProtocolAuthAdapter({ runProtocolRegister, runProtocolLogin }) {
  return {
    async register(account, options) {
      return runProtocolRegister(account, options);
    },
    async login(account, options) {
      return runProtocolLogin(account, options);
    },
  };
}
