function invalidWorkspacePage() {
  return Object.assign(new Error('授权页工作区数据不完整或格式不受支持；未重新提交账号凭据'), {
    code: 'WORKSPACE_PAGE_INVALID',
  });
}

const businessWorkspaceKinds = new Set(['workspace', 'organization', 'team', 'business', 'enterprise']);

export function workspaceOwnershipKind(kind) {
  if (kind === 'personal') return 'personal';
  return businessWorkspaceKinds.has(kind) ? 'business' : null;
}

export function normalizeCatalog(value) {
  if (!Array.isArray(value)) throw invalidWorkspacePage();
  const workspaces = new Map();
  for (const item of value) {
    const id = item?.id ?? item?.workspace_id;
    const kind = item?.kind ?? item?.type ?? item?.structure;
    if (typeof id !== 'string' || !id.trim() || typeof kind !== 'string' || !kind.trim()) throw invalidWorkspacePage();
    const workspace = { id: id.trim(), kind: kind.trim().toLowerCase() };
    const ownership = workspaceOwnershipKind(workspace.kind);
    for (const alias of [item.kind, item.type, item.structure]) {
      if (alias == null) continue;
      const label = typeof alias === 'string' ? alias.trim().toLowerCase() : '';
      if (label !== workspace.kind && (!ownership || workspaceOwnershipKind(label) !== ownership)) {
        throw invalidWorkspacePage();
      }
    }
    if (item.workspace_id != null && (typeof item.workspace_id !== 'string' || item.workspace_id.trim() !== workspace.id)) throw invalidWorkspacePage();
    if (workspaces.has(workspace.id) && workspaces.get(workspace.id).kind !== workspace.kind) throw invalidWorkspacePage();
    workspaces.set(workspace.id, workspace);
  }
  return { workspaces: [...workspaces.values()] };
}

// New auth responses carry the session in JSON while cookies contain only a
// minimized, opaque session. Keep just the current workspace IDs and kinds.
export function readAuthWorkspacePayload(payload) {
  const catalogs = [payload?.['oai-client-auth-session'], payload?.page?.payload]
    .filter(value => value && Object.hasOwn(value, 'workspaces'))
    .map(value => normalizeCatalog(value.workspaces));
  if (!catalogs.length) return null;
  const signature = catalog => JSON.stringify(catalog.workspaces.map(item => [item.id, item.kind]).sort());
  if (catalogs.some(catalog => signature(catalog) !== signature(catalogs[0]))) throw invalidWorkspacePage();
  return catalogs[0];
}

// React Router serializes loader data as a table of references. Read only
// workspace IDs/types; never evaluate page JavaScript or retain user metadata.
function readStreamCatalogs(table) {
  if (!Array.isArray(table)) return [];
  const at = ref => Number.isInteger(ref) && ref >= 0 ? table[ref] : undefined;
  const fields = record => Object.fromEntries(Object.entries(record || {}).flatMap(([key, ref]) => {
    const match = key.match(/^_(\d+)$/);
    const name = match ? at(Number(match[1])) : '';
    return ['id', 'workspace_id', 'kind', 'type', 'structure'].includes(name) ? [[name, at(ref)]] : [];
  }));
  const catalogs = [];
  for (const entry of table) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    for (const [key, ref] of Object.entries(entry)) {
      const match = key.match(/^_(\d+)$/);
      if (!match || at(Number(match[1])) !== 'workspaces') continue;
      const list = at(ref);
      if (!Array.isArray(list)) throw invalidWorkspacePage();
      catalogs.push(normalizeCatalog(list.map(item => fields(at(item)))));
    }
  }
  return catalogs;
}

export function readWorkspacePagePayload(html = '') {
  const source = String(html);
  if (source.length > 2 * 1024 * 1024) throw invalidWorkspacePage();
  const catalogs = [];
  const chunks = [];
  for (const [, attributes, body] of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\btype\s*=\s*["']application\/json["']/i.test(attributes)) {
      let parsed;
      try { parsed = JSON.parse(body); } catch { continue; }
      const pending = [parsed];
      while (pending.length) {
        const item = pending.pop();
        if (!item || typeof item !== 'object') continue;
        if (Object.hasOwn(item, 'workspaces')) catalogs.push(normalizeCatalog(item.workspaces));
        pending.push(...Object.values(item).filter(value => value && typeof value === 'object'));
      }
    } else {
      for (const match of body.matchAll(/\bstreamController\.enqueue\(\s*("(?:\\.|[^"\\])*")\s*\)/g)) {
        try { chunks.push(JSON.parse(match[1])); } catch { /* Not JSON data. */ }
      }
    }
  }
  // Stream frames are newline-delimited; one frame may span multiple scripts.
  for (const frame of chunks.join('').split('\n')) {
    if (!frame.trim()) continue;
    let table;
    try { table = JSON.parse(frame); } catch { continue; }
    catalogs.push(...readStreamCatalogs(table));
  }
  if (!catalogs.length) return null;
  const signature = catalog => JSON.stringify(catalog.workspaces.map(item => [item.id, item.kind]).sort());
  if (catalogs.some(catalog => signature(catalog) !== signature(catalogs[0]))) throw invalidWorkspacePage();
  return catalogs[0];
}
