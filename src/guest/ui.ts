import type { SharedFile } from '../shares/service.js';
import type { SharedWhitepad } from '../texts/service.js';
import { addPreview } from '../shares/preview-ui.js';

interface GuestCatalog {
  name: string;
  label: string;
  expires: number;
  scope: 'session' | 'selected';
  shares: {
    id: string;
    name: string;
    kind: 'file' | 'directory';
    count: number;
    file?: SharedFile;
  }[];
  whitepad: SharedWhitepad | null;
}
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const write = (id: string, text: string) => {
  el(id).textContent = text;
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
let catalog: GuestCatalog | undefined;
let active = true;
let live: EventSource | undefined;
let shareId = '';
let files: SharedFile[] = [];
let next: number | null = null;
let fileVersion = 0;
let refreshing = false;
let refreshPending = false;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  content?: string,
) {
  const value = document.createElement(tag);
  if (content !== undefined) value.textContent = content;
  return value;
}
function endAccess(reason: string): void {
  active = false;
  fileVersion++;
  live?.close();
  live = undefined;
  catalog = undefined;
  files = [];
  el('guest-app').hidden = true;
  el('leave').hidden = true;
  el('gate').hidden = false;
  for (const id of [
    'collections',
    'files',
    'text-content',
    'text-meta',
    'guest-error',
    'feedback',
  ])
    el(id).replaceChildren();
  write('gate-message', reason);
  write('live', 'Access ended');
}
async function api<T>(
  route: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/guest${route}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw new Error(
      'The publisher is unavailable, or the tunnel requires a browser confirmation. Reopen the original link to retry.',
    );
  const result = await response.json();
  if (!response.ok) {
    const reason = result.error ?? `Request failed (HTTP ${response.status}).`;
    if (response.status === 401) endAccess(reason);
    throw new Error(reason);
  }
  return result as T;
}
async function action(work: () => Promise<void>): Promise<void> {
  write('guest-error', '');
  try {
    await work();
  } catch (error) {
    if (active) write('guest-error', message(error));
  }
}
const size = (value: number) =>
  value < 1024
    ? `${value} B`
    : value < 1024 * 1024
      ? `${(value / 1024).toFixed(0)} KB`
      : `${(value / 1024 / 1024).toFixed(1)} MB`;

function downloadLink(id: string, file: SharedFile): HTMLAnchorElement {
  const download = element('a', 'Download');
  download.className = 'download';
  download.href = `/guest/shares/${encodeURIComponent(id)}/files/${encodeURIComponent(file.id)}/content`;
  download.download = file.name.split(/[/\\]/).at(-1) ?? 'download';
  download.setAttribute('aria-label', `Download ${file.name}`);
  download.target = '_blank';
  download.rel = 'noreferrer';
  return download;
}

function renderFiles(): void {
  if (!catalog || !active) return;
  const share = catalog.shares.find(
    (entry) => entry.id === shareId && entry.kind === 'directory',
  );
  const collections = el('collections');
  collections.hidden = Boolean(share);
  el('file-browser').hidden = !share;
  el('files-empty').hidden = catalog.shares.length > 0;
  write(
    'files-empty',
    catalog.scope === 'session'
      ? 'No files shared yet. New shares will appear here automatically.'
      : 'No files available through this link right now.',
  );
  collections.replaceChildren();
  for (const entry of catalog.shares) {
    if (entry.kind === 'file' && entry.file) {
      const item = downloadLink(entry.id, entry.file);
      item.classList.add('collection');
      item.replaceChildren(
        element('strong', entry.name),
        element('small', size(entry.file.size)),
        element('span', 'Download'),
      );
      addPreview(
        item,
        entry.file,
        `/guest/shares/${entry.id}/files/${entry.file.id}/preview`,
      );
      collections.append(item);
      continue;
    }
    const item = element('button');
    item.className = 'collection';
    item.setAttribute('aria-label', `Open ${entry.name}`);
    item.append(
      element('strong', entry.name),
      element(
        'small',
        `${entry.count} ${entry.count === 1 ? 'file' : 'files'} available`,
      ),
      element('span', 'Open folder →'),
    );
    item.addEventListener(
      'click',
      () =>
        void action(async () => {
          shareId = entry.id;
          files = [];
          next = 0;
          el<HTMLInputElement>('file-filter').value = '';
          renderFiles();
          await loadFiles(false);
        }),
    );
    collections.append(item);
  }
  if (!share) return;
  write('collection-name', share.name);
  const query = el<HTMLInputElement>('file-filter').value.toLowerCase();
  const visible = files.filter((file) =>
    file.name.toLowerCase().includes(query),
  );
  const container = el('files');
  container.replaceChildren();
  for (const file of visible) {
    const row = element('div');
    row.className = 'file-row';
    const name = element('span', file.name);
    name.className = 'file-name';
    addPreview(name, file, `/guest/shares/${shareId}/files/${file.id}/preview`);
    const meta = element('span', size(file.size));
    meta.className = 'file-size';
    row.append(name, meta, downloadLink(shareId, file));
    container.append(row);
  }
  if (!visible.length) {
    const empty = element(
      'p',
      files.length
        ? 'No matches in the loaded files.'
        : 'No files in this folder right now.',
    );
    empty.className = 'empty';
    container.append(empty);
  }
  write(
    'file-count',
    `${visible.length} shown · ${files.length} loaded of ${share.count} files`,
  );
  el('more').hidden = next === null;
}

async function loadFiles(replace: boolean): Promise<void> {
  if (!shareId || (!replace && next === null)) return;
  const version = ++fileVersion;
  const id = shareId;
  const target = replace ? Math.max(files.length, 100) : 0;
  const loaded: SharedFile[] = [];
  let offset: number | null = replace ? 0 : next;
  el<HTMLButtonElement>('more').disabled = true;
  try {
    do {
      const page: { files: SharedFile[]; next: number | null } = await api(
        `/shares/${encodeURIComponent(id)}/files?offset=${offset ?? 0}`,
      );
      if (page.next !== null && page.next <= (offset ?? 0))
        throw new Error('Invalid file catalog pagination.');
      loaded.push(...page.files);
      offset = page.next;
    } while (offset !== null && loaded.length < target);
    if (!active || version !== fileVersion || id !== shareId) return;
    const previous = JSON.stringify([files, next]);
    files = replace ? loaded : [...files, ...loaded];
    next = offset;
    if (previous !== JSON.stringify([files, next])) renderFiles();
  } finally {
    if (version === fileVersion) el<HTMLButtonElement>('more').disabled = false;
  }
}

function renderTexts(): void {
  if (!catalog || !active) return;
  const pad = catalog.whitepad;
  el('text-detail').hidden = !pad;
  el('text-empty').hidden = Boolean(pad?.content);
  write(
    'text-empty',
    pad
      ? 'The whitepad is empty. Text will appear here as the host types.'
      : 'This older link does not include the whitepad. Ask the host for a new session link.',
  );
  write(
    'text-meta',
    pad
      ? `${pad.content.length.toLocaleString()} characters · Read-only · Updates live`
      : '',
  );
  const content = pad?.content ?? '';
  if (el('text-content').textContent !== content)
    write('text-content', content);
  write('feedback', '');
}

async function refresh(): Promise<void> {
  if (!active) return;
  if (refreshing) {
    refreshPending = true;
    return;
  }
  refreshing = true;
  try {
    do {
      refreshPending = false;
      const result = await api<GuestCatalog>('/catalog');
      if (!active) return;
      const previous = catalog;
      catalog = result;
      if (
        shareId &&
        !result.shares.some(
          (share) => share.id === shareId && share.kind === 'directory',
        )
      ) {
        fileVersion++;
        shareId = '';
        files = [];
        next = null;
      }
      write('publisher', result.name);
      write('link-label', result.label);
      write(
        'expiry',
        `Available until ${new Date(result.expires).toLocaleString()} · ${result.scope === 'session' ? 'Entire session · New files and text appear automatically' : 'Only items chosen for this older link'}`,
      );
      if (JSON.stringify(previous?.shares) !== JSON.stringify(result.shares))
        renderFiles();
      if (
        JSON.stringify(previous?.whitepad) !== JSON.stringify(result.whitepad)
      )
        renderTexts();
      if (shareId) await loadFiles(true);
      if (!active) return;
      if (!previous && !result.shares.length && result.whitepad)
        el('texts-tab').click();
      el('guest-app').hidden = false;
      el('gate').hidden = true;
      el('leave').hidden = false;
      write('guest-error', '');
    } while (active && refreshPending);
  } finally {
    refreshing = false;
  }
}

function startLive(): void {
  live = new EventSource('/guest/events');
  live.onopen = () => write('live', 'Live');
  live.onmessage = () => void action(refresh);
  live.onerror = () => {
    if (!active) return;
    write('live', 'Reconnecting…');
    void action(refresh);
  };
}
el('files-tab').addEventListener('click', () => {
  el('files-pane').hidden = false;
  el('texts-pane').hidden = true;
  el('files-tab').setAttribute('aria-pressed', 'true');
  el('texts-tab').setAttribute('aria-pressed', 'false');
});
el('texts-tab').addEventListener('click', () => {
  el('files-pane').hidden = true;
  el('texts-pane').hidden = false;
  el('files-tab').setAttribute('aria-pressed', 'false');
  el('texts-tab').setAttribute('aria-pressed', 'true');
});
el('back').addEventListener('click', () => {
  fileVersion++;
  shareId = '';
  files = [];
  next = null;
  renderFiles();
});
el('file-filter').addEventListener('input', renderFiles);
el('more').addEventListener('click', () => void action(() => loadFiles(false)));
el('copy').addEventListener(
  'click',
  () =>
    void action(async () => {
      if (!catalog?.whitepad || !navigator.clipboard)
        throw new Error(
          'Clipboard is unavailable. Use Select text and copy manually.',
        );
      await navigator.clipboard.writeText(catalog.whitepad.content);
      write('feedback', 'Copied to clipboard.');
    }),
);
el('select').addEventListener(
  'click',
  () =>
    void action(async () => {
      const selection = window.getSelection();
      if (!selection)
        throw new Error('Text selection is unavailable in this browser.');
      el('text-content').focus();
      selection.selectAllChildren(el('text-content'));
      write('feedback', 'Text selected. Use your usual Copy shortcut.');
    }),
);
el('leave').addEventListener(
  'click',
  () =>
    void action(async () => {
      await api('/logout', 'POST');
      endAccess(
        'You have left this guest page. Reopen the original link to return while it is still valid.',
      );
    }),
);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && active && catalog) void action(refresh);
});
window.addEventListener('hashchange', () => {
  // Opening another invitation may only navigate the current document's fragment.
  if (location.hash) location.reload();
});
void (async () => {
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  history.replaceState(null, '', location.pathname);
  try {
    if (token) await api('/session', 'POST', { token });
    await refresh();
    if (active) startLive();
  } catch (error) {
    endAccess(message(error));
  }
})();
