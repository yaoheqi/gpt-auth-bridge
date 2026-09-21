/* Atomic revision checks protect credentials across tabs, including after clear. */
(() => {
  let database;
  let queue = Promise.resolve();
  let revision;
  let blocked = false;
  let clearing;
  let notifiedRevision = -1;
  const source = Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join('-');
  let invalidationKind = 'conflict';
  const listeners = new Set();
  let controller = new AbortController();
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('session-converter-workspace') : null;
  function invalidate(kind) {
    if (blocked && (kind === 'conflict' || invalidationKind === 'clear' || invalidationKind === kind)) return;
    blocked = true;
    invalidationKind = kind;
    controller.abort();
    for (const listener of listeners) listener(kind);
  }
  if (channel) channel.onmessage = async ({ data }) => {
    // A new tab may already have read the revision announced by this message.
    if (revision === undefined) {
      try { await read(); } catch { invalidate('conflict'); return; }
    }
    if (data?.source !== source && Number(data?.revision) > Math.max(revision ?? -1, notifiedRevision)) {
      notifiedRevision = Number(data.revision);
      invalidate(data.kind);
    }
  };
  async function db() {
    if (!database) database = new Promise((resolve, reject) => {
      const request = indexedDB.open('session-converter-browser', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('workspace');
      request.onsuccess = () => {
        const connection = request.result;
        connection.onversionchange = () => { connection.close(); database = null; invalidate('conflict'); };
        resolve(connection);
      };
      request.onerror = () => { database = null; reject(request.error); };
    });
    return database;
  }
  function conflict() {
    invalidate('conflict');
    return Object.assign(new Error('另一个标签页已更新或清空数据，请刷新后继续'), { code: 'WORKSPACE_CONFLICT' });
  }
  async function read() {
    const connection = await db();
    const stored = await new Promise((resolve, reject) => {
      const tx = connection.transaction('workspace', 'readonly');
      const store = tx.objectStore('workspace');
      const meta = store.get('revision');
      const current = store.get('current');
      const key = store.get('encryption-key');
      tx.oncomplete = () => { revision ??= Number(meta.result || 0); resolve({ value: current.result, key: key.result }); };
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('浏览器存储不可用'));
    });
    if (stored.value === undefined) return undefined;
    if (stored.value?.encryption === 'AES-GCM-v1') {
      if (!stored.key) throw new Error('浏览器加密密钥丢失');
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: stored.value.iv }, stored.key, stored.value.data);
      return JSON.parse(new TextDecoder().decode(plaintext));
    }
    if (stored.value?.encryption) throw new Error('无法读取此版本的浏览器加密数据');
    // Migrate old plaintext snapshots before the page starts accepting edits.
    await write(stored.value);
    return stored.value;
  }
  async function write(snapshot, kind = 'change') {
    const clear = kind !== 'change';
    const preserve = kind === 'clear-login';
    if (!clear && blocked) throw conflict();
    if (revision === undefined && (!clear || preserve)) await read();
    const connection = await db();
    let key, encrypted;
    if (!clear || preserve) {
      if (!crypto.subtle) throw new Error('加密存储需要 HTTPS 或 localhost');
      if (!preserve) key = await new Promise((resolve, reject) => {
        const tx = connection.transaction('workspace', 'readonly');
        const request = tx.objectStore('workspace').get('encryption-key');
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
      key ||= await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(snapshot)));
      encrypted = { encryption: 'AES-GCM-v1', iv, data };
    }
    return new Promise((resolve, reject) => {
      const tx = connection.transaction('workspace', 'readwrite');
      const store = tx.objectStore('workspace');
      const meta = store.get('revision');
      let failure;
      let nextRevision;
      meta.onsuccess = () => {
        const current = Number(meta.result || 0);
        if ((!clear || preserve) && ((!clear && blocked) || current !== revision)) {
          failure = conflict();
          tx.abort();
          return;
        }
        nextRevision = current + 1;
        if (clear) store.clear();
        if (!clear || preserve) {
          store.put(encrypted, 'current');
          store.put(key, 'encryption-key');
        }
        store.put(nextRevision, 'revision');
      };
      tx.oncomplete = () => {
        revision = nextRevision;
        channel?.postMessage({ source, revision, kind });
        resolve();
      };
      tx.onerror = tx.onabort = () => reject(failure || tx.error || new Error('浏览器存储不可用'));
    });
  }
  function enqueue(run) {
    const pending = queue.then(run);
    queue = pending.catch(() => {});
    return pending;
  }
  function reset(kind, value) {
    if (clearing) return clearing;
    if (kind === 'clear-login' && blocked) return Promise.reject(conflict());
    const snapshot = value === undefined ? undefined : structuredClone(value);
    blocked = true;
    invalidationKind = kind;
    controller.abort();
    clearing = enqueue(() => write(snapshot, kind)).then(() => {
      if (notifiedRevision <= revision) {
        controller = new AbortController();
        blocked = false;
      }
    }).finally(() => { clearing = null; });
    return clearing;
  }
  window.browserWorkspace = {
    read,
    get signal() { return controller.signal; },
    subscribe(listener) {
      listeners.add(listener);
      if (blocked) queueMicrotask(() => listener(invalidationKind));
      return () => listeners.delete(listener);
    },
    save(value) {
      if (blocked) return Promise.reject(conflict());
      const snapshot = structuredClone(value);
      return enqueue(() => write(snapshot));
    },
    clear: () => reset('clear'),
    clearLoginData: value => reset('clear-login', value),
  };
})();
