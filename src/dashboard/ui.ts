import type { SharedWhitepad } from '../texts/service.js';
import type { GuestLinkSummary } from '../guest/access.js';
import type { SharedFile } from '../shares/service.js';
import { addPreview } from '../shares/preview-ui.js';

interface DashboardState {
  name: string;
  id: string;
  shares: {
    id: string;
    name: string;
    kind: 'file' | 'directory';
    count: number;
    path: string;
    warnings: string[];
    file?: SharedFile;
  }[];
  configuredShares: { id: string; path: string; copied: boolean }[];
  whitepad: SharedWhitepad;
  guestLinks: GuestLinkSummary[];
  guestOrigin?: string;
  access: 'lan' | 'tunnel';
  tunnel: { status: string; url?: string; external: boolean };
  warnings: string[];
}
interface LocalListing {
  path: string;
  parent: string | null;
  selected: string | null;
  entries: { name: string; path: string; kind: 'directory' | 'file' }[];
  omitted: number;
  truncated: boolean;
}
const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const dialog = (id: string) => element<HTMLDialogElement>(id);
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
let csrf = '';
let unlocked = false;
let polling = false;
let refreshPending = false;
let updates: EventSource | undefined;
let livePending = false;
let applyingLive = false;
let state: DashboardState | undefined;
let view: 'shares' | 'texts' = 'shares';
let shareSignature = '';
let listing: LocalListing | undefined;
let pickerVersion = 0;
let pickerLoading = false;
let revokeId = '';
let pad: SharedWhitepad | undefined;
let padDirty = false;
let padSaving = false;
let padPaused = false;
let padTimer: ReturnType<typeof setTimeout> | undefined;
let padGeneration = 0;
let generatedGuestId = '';
let revealId = '';
let revealTimer: ReturnType<typeof setTimeout> | undefined;
let copying: AbortController | undefined;

function clearGuestInvitation(): void {
  generatedGuestId = '';
  element<HTMLInputElement>('generated-url').value = '';
  element<HTMLInputElement>('generated-pin').value = '';
  element('guest-pin').hidden = true;
  text('pin-expiry', '');
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const item = document.createElement(tag);
  item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}
function icon(name: string): SVGSVGElement {
  const item = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  item.setAttribute('class', 'icon');
  item.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  item.append(use);
  return item;
}
function text(id: string, value: string): void {
  element(id).textContent = value;
}
function basename(input: string): string {
  return input.split(/[/\\]/).filter(Boolean).at(-1) ?? input;
}

async function api<T>(
  route: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${route}`, {
    method,
    headers: {
      'x-p2pfs-csrf': csrf,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      if (padDirty || padSaving)
        throw new Error(
          'Workspace session expired. Copy your unsaved whitepad text before reloading and unlocking.',
        );
      lock();
    }
    throw new Error(result.error ?? `HTTP ${response.status}`);
  }
  return result as T;
}

function lock(): void {
  copying?.abort();
  unlocked = false;
  updates?.close();
  updates = undefined;
  livePending = false;
  csrf = '';
  state = undefined;
  pickerVersion++;
  padGeneration++;
  clearTimeout(padTimer);
  padTimer = undefined;
  pad = undefined;
  padDirty = false;
  padSaving = false;
  padPaused = false;
  listing = undefined;
  shareSignature = '';
  element<HTMLTextAreaElement>('whitepad').value = '';
  element<HTMLFormElement>('guest-form').reset();
  clearGuestInvitation();
  element('guest-list').replaceChildren();
  delete element('guest-list').dataset.signature;
  element('pad-recovery').hidden = true;
  for (const id of [
    'pad-status',
    'pad-count',
    'text-feedback',
    'text-error',
    'guest-link-error',
    'guest-link-feedback',
  ])
    text(id, '');
  document.querySelectorAll('dialog').forEach((item) => item.close());
  element('app').hidden = true;
  element('login').hidden = false;
  for (const id of ['catalog', 'picker-entries']) element(id).replaceChildren();
  element<HTMLInputElement>('password').focus();
}

async function action(
  work: () => Promise<void>,
  trigger?: HTMLButtonElement,
  errorId = 'error-text',
): Promise<void> {
  if (trigger?.disabled) return;
  if (trigger) trigger.disabled = true;
  text(errorId, '');
  try {
    await work();
  } catch (error) {
    text(errorId, message(error));
  } finally {
    if (trigger) trigger.disabled = false;
  }
}

function button(
  label: string,
  work: () => Promise<void>,
  className = 'secondary',
  iconName?: string,
  errorId?: string,
): HTMLButtonElement {
  const item = node('button', className);
  item.type = 'button';
  if (iconName) item.append(icon(iconName));
  if (className === 'icon-button') {
    item.setAttribute('aria-label', label);
    item.title = label;
  } else item.append(document.createTextNode(label));
  item.addEventListener('click', () => void action(work, item, errorId));
  return item;
}

function empty(
  title: string,
  description: string,
  iconName = 'folder',
): HTMLElement {
  const item = node('div', 'empty');
  item.append(
    icon(iconName),
    node('h3', '', title),
    node('p', '', description),
  );
  return item;
}
function fileRow(
  name: string,
  subtitle: string,
  meta: string,
  folder = false,
): { row: HTMLElement; actions: HTMLElement } {
  const row = node('div', 'file-row');
  const info = node('div', 'file-info');
  const badge = node('span', `file-badge${folder ? ' folder' : ''}`);
  badge.append(icon(folder ? 'folder' : 'file'));
  const label = node('div', 'stack');
  label.append(
    node('span', 'file-title', name),
    node('span', 'file-subtitle', subtitle),
  );
  info.append(badge, label);
  const actions = node('div', 'file-actions');
  row.append(info, node('span', 'file-meta', meta), actions);
  return { row, actions };
}

async function refresh(): Promise<void> {
  if (!unlocked) return;
  if (polling) {
    refreshPending = true;
    return;
  }
  polling = true;
  try {
    const next = await api<DashboardState>('/state');
    if (!unlocked) return;
    state = next;
    element('app').hidden = false;
    element('login').hidden = true;
    const previousShares = shareSignature;
    shareSignature = JSON.stringify([next.shares, next.configuredShares]);
    receivePad(next.whitepad);
    text('identity', next.name);
    text('share-count', String(next.configuredShares.length));
    if (dialog('guest-dialog').open) renderGuestLinks();
    element('file-browser').hidden = view === 'texts';
    element('text-workspace').hidden = view !== 'texts';
    element('add-share').hidden = view !== 'shares';
    text('warnings', next.warnings.join(' '));
    text(
      'connection-label',
      next.access === 'lan'
        ? 'Local network sharing'
        : next.tunnel.url
          ? 'Tunnel is live'
          : 'Connection settings',
    );
    if (previousShares !== shareSignature && view === 'shares') renderCatalog();
    renderConnection();
    if (!updates) startLive();
  } finally {
    polling = false;
    if (refreshPending) {
      refreshPending = false;
      void refresh().catch((error: unknown) =>
        text('error-text', message(error)),
      );
    }
  }
}

function switchView(next: 'shares' | 'texts'): void {
  if (!state) return;
  view = next;
  text('notice', '');
  element<HTMLInputElement>('search').value = '';
  element('nav-shares').setAttribute(
    'aria-current',
    next === 'shares' ? 'page' : 'false',
  );
  element('nav-texts').setAttribute(
    'aria-current',
    next === 'texts' ? 'page' : 'false',
  );
  text(
    'view-title',
    next === 'texts' ? 'One shared whitepad.' : 'Out in the open.',
  );
  text(
    'view-description',
    next === 'texts'
      ? 'Just type. Your text saves automatically and streams to everyone with a session link.'
      : 'Choose what to share. Send a private link. Your originals stay put.',
  );
  element('add-share').hidden = next !== 'shares';
  element('file-browser').hidden = next === 'texts';
  element('text-workspace').hidden = next !== 'texts';
  renderCatalog();
}

function renderCatalog(): void {
  if (!state || view === 'texts') return;
  const container = element('catalog');
  const crumbs = element('breadcrumbs');
  container.replaceChildren();
  crumbs.replaceChildren();
  const query = element<HTMLInputElement>('search').value.toLocaleLowerCase();
  const matches = (name: string) => name.toLocaleLowerCase().includes(query);
  text('list-caption', '');
  if (view === 'shares') {
    crumbs.append(
      icon('folder'),
      node('strong', '', 'Shared from this machine'),
    );
    const shares = state.configuredShares.filter((share) =>
      matches(share.path),
    );
    for (const share of shares) {
      const indexed = state.shares.find((entry) => entry.id === share.id);
      const { row, actions } = fileRow(
        indexed?.name ?? basename(share.path),
        [
          share.copied ? 'Local copy · Original unchanged' : share.path,
          ...(indexed?.warnings ?? []),
        ].join(' · '),
        indexed
          ? `${indexed.count} ${indexed.count === 1 ? 'file' : 'files'}`
          : 'Unavailable',
        indexed?.kind !== 'file',
      );
      if (indexed?.file)
        addPreview(
          row.querySelector('.file-badge')!,
          indexed.file,
          `/api/shares/${share.id}/files/${indexed.file.id}`,
        );
      if (indexed)
        actions.append(
          button(
            'Re-index share',
            async () => {
              await api(`/shares/${share.id}/refresh`, 'POST');
              await refresh();
              text(
                'notice',
                'Share re-indexed. Browser recipients update automatically.',
              );
            },
            'icon-button',
            'refresh',
          ),
        );
      actions.append(
        button(
          'Stop sharing',
          async () => {
            revokeId = share.id;
            text('revoke-path', share.path);
            text(
              'revoke-copy-note',
              share.copied
                ? 'The local copy will be deleted. Your original file is unchanged.'
                : '',
            );
            text('revoke-error', '');
            dialog('revoke-dialog').showModal();
          },
          'icon-button',
          'close',
        ),
      );
      container.append(row);
    }

    if (!shares.length)
      container.append(
        empty(
          query
            ? 'Nothing by that name.'
            : 'Keep your files. Share the access.',
          query
            ? 'Try a different name or path.'
            : 'Choose a file or folder, then create a private session link. Nothing else on this machine is published.',
        ),
      );
    text(
      'list-caption',
      `${shares.length} of ${state.configuredShares.length} shares · Read-only access`,
    );
    return;
  }
}

function padStatus(): void {
  text(
    'pad-count',
    `${element<HTMLTextAreaElement>('whitepad').value.length.toLocaleString()} / 1,000,000 characters`,
  );
  text(
    'pad-status',
    padPaused
      ? 'Not saved'
      : padSaving
        ? 'Saving…'
        : padDirty
          ? 'Waiting to save…'
          : 'Saved · Live with receivers',
  );
  element('pad-recovery').hidden = !padPaused;
}

function receivePad(next: SharedWhitepad): void {
  if (pad && next.revision < pad.revision) return;
  if (padDirty || padSaving || padPaused) return;
  pad = next;
  const input = element<HTMLTextAreaElement>('whitepad');
  if (input.value !== next.content) input.value = next.content;
  input.disabled = false;
  padStatus();
}

function schedulePad(): void {
  if (padTimer || padSaving || padPaused || !unlocked) return;
  padTimer = setTimeout(() => {
    padTimer = undefined;
    void savePad();
  }, 200);
}

async function savePad(): Promise<void> {
  if (!pad || !padDirty || padSaving || padPaused || !unlocked) return;
  const generation = padGeneration;
  const content = element<HTMLTextAreaElement>('whitepad').value;
  padSaving = true;
  text('text-error', '');
  padStatus();
  try {
    const saved = await api<SharedWhitepad>('/whitepad', 'PUT', {
      content,
      revision: pad.revision,
    });
    if (!unlocked || generation !== padGeneration) return;
    pad = saved;
    padDirty = element<HTMLTextAreaElement>('whitepad').value !== content;
  } catch (error) {
    if (unlocked && generation === padGeneration) {
      padPaused = true;
      text('text-error', message(error));
    }
  } finally {
    if (unlocked && generation === padGeneration) {
      padSaving = false;
      padStatus();
      if (padDirty) schedulePad();
      else queueLive();
    }
  }
}

async function recoverPad(useSaved: boolean): Promise<void> {
  const generation = padGeneration;
  const controls = ['pad-retry', 'pad-reload'].map((id) =>
    element<HTMLButtonElement>(id),
  );
  for (const control of controls) control.disabled = true;
  try {
    const latest = await api<SharedWhitepad>('/whitepad');
    if (!unlocked || generation !== padGeneration) return;
    padPaused = false;
    if (useSaved) {
      padDirty = false;
      receivePad(latest);
    } else {
      pad = latest;
      await savePad();
    }
  } finally {
    for (const control of controls) control.disabled = false;
  }
}

function startLive(): void {
  updates = new EventSource('/api/events');
  text('live-status', 'Connecting…');
  updates.onopen = () => {
    text('live-status', 'Live');
    if (element('error-text').textContent?.startsWith('Live connection lost:'))
      text('error-text', '');
  };
  updates.onmessage = () => queueLive();
  updates.onerror = () => {
    text('live-status', 'Reconnecting…');
    void refresh().catch((error: unknown) =>
      text('error-text', `Live connection lost: ${message(error)}`),
    );
  };
}

function queueLive(): void {
  livePending = true;
  void applyLive();
}

async function applyLive(): Promise<void> {
  if (applyingLive) return;
  applyingLive = true;
  try {
    while (unlocked && livePending) {
      livePending = false;
      await refresh();
    }
  } catch (error) {
    text('error-text', message(error));
  } finally {
    applyingLive = false;
  }
}
function renderConnection(): void {
  if (!state) return;
  text('connection-name', state.name);
  text('connection-id', state.id);
  element('external-tunnel-note').hidden = !state.tunnel.external;
  element('managed-tunnel-controls').hidden =
    state.access === 'lan' || state.tunnel.external;
  text(
    'endpoint-label',
    state.access === 'lan' ? 'LOCAL NETWORK ENDPOINT' : 'PUBLIC ENDPOINT',
  );
  text(
    'connection-note',
    state.access === 'lan'
      ? 'Only devices that can reach this local network address can connect. HTTP traffic is not encrypted; use a trusted network. No router port forwarding is needed. To stop access, quit the publisher. Edit host.json and restart to choose a fixed LAN address or tunnel mode.'
      : "Connection settings are managed in the host's configuration file. Traffic passes through an HTTPS relay; this is not end-to-end encryption.",
  );
  text('tunnel-status', state.tunnel.status);
  const url = element<HTMLAnchorElement>('tunnel-url');
  url.hidden = !state.tunnel.url;
  url.textContent = state.tunnel.url ?? '';
  if (state.tunnel.url) url.href = state.tunnel.url;
  else url.removeAttribute('href');
}

async function browseLocal(input?: string): Promise<void> {
  const version = ++pickerVersion;
  const pathInput = element<HTMLInputElement>('picker-path');
  const requestedPath = input ?? '';
  pathInput.value = requestedPath;
  pickerLoading = true;
  listing = undefined;
  element<HTMLButtonElement>('picker-up').disabled = true;
  element<HTMLButtonElement>('picker-share').disabled = true;
  element('picker-entries').replaceChildren(
    node('p', 'picker-status', 'Reading this folder…'),
  );
  text('picker-error', '');
  text('picker-hint', '');
  text('picker-kind', 'READING FOLDER');
  text('picker-selection', '');
  const query = new URLSearchParams({
    hidden: String(element<HTMLInputElement>('picker-hidden').checked),
    ...(input ? { path: input } : {}),
  });
  try {
    const result = await api<LocalListing>(`/filesystem?${query}`);
    if (version !== pickerVersion || !unlocked) return;
    listing = result;
    if (pathInput.value === requestedPath) pathInput.value = result.path;
    renderPicker();
  } catch (error) {
    if (version !== pickerVersion) return;
    text('picker-error', message(error));
    element('picker-entries').replaceChildren(
      node(
        'p',
        'picker-status',
        'Could not open this location. Enter a different path or go Home.',
      ),
    );
    text('picker-kind', 'LOCATION UNAVAILABLE');
  } finally {
    if (version === pickerVersion) pickerLoading = false;
  }
}

function renderPicker(): void {
  if (!listing) return;
  const current = listing;
  const container = element('picker-entries');
  container.replaceChildren();
  element<HTMLButtonElement>('picker-up').disabled = current.parent === null;
  for (const entry of current.entries) {
    const item = button(
      '',
      async () => {
        if (entry.kind === 'directory') await browseLocal(entry.path);
        else {
          current.selected = entry.path;
          renderPicker();
          // Keep keyboard navigation at the selected file after updating the list.
          container
            .querySelector<HTMLButtonElement>('[aria-pressed=true]')
            ?.focus();
        }
      },
      'picker-entry',
      entry.kind === 'directory' ? 'folder' : 'file',
      'picker-error',
    );
    item.setAttribute(
      'aria-label',
      `${entry.kind === 'directory' ? 'Open folder' : 'Select file'} ${entry.name}`,
    );
    item.setAttribute('aria-pressed', String(current.selected === entry.path));
    item.append(node('span', 'truncate', entry.name));
    if (entry.kind === 'directory') item.append(icon('chevron'));
    else if (current.selected === entry.path) item.append(icon('check'));
    container.append(item);
  }
  if (!current.entries.length)
    container.append(
      node(
        'p',
        'picker-status',
        'No visible files here. You can still share this folder.',
      ),
    );
  text(
    'picker-hint',
    [
      current.truncated
        ? 'Showing the first 1,000 directory entries. Enter a more specific path to find other items.'
        : '',
      current.omitted
        ? `${current.omitted} links or unsupported entries omitted.`
        : '',
      'Folder shares include nested and hidden files. Symlinks are not shared.',
    ]
      .filter(Boolean)
      .join(' '),
  );
  text('picker-kind', current.selected ? 'SELECTED FILE' : 'CURRENT FOLDER');
  const selection = current.selected ?? current.path;
  text('picker-selection', basename(selection));
  element('picker-selection').title = selection;
  const share = element<HTMLButtonElement>('picker-share');
  share.textContent = current.selected
    ? 'Share this file'
    : 'Share this folder';
  share.disabled = false;
}

function onClick(
  id: string,
  work: () => Promise<void>,
  errorId?: string,
): void {
  const trigger = element<HTMLButtonElement>(id);
  trigger.addEventListener('click', () => void action(work, trigger, errorId));
}

function renderGuestLinks(): void {
  if (!state) return;
  if (
    revealId &&
    !state.guestLinks.some(
      (link) => link.id === revealId && (link.pinExpires ?? 0) > Date.now(),
    )
  )
    dialog('pin-dialog').close();
  const container = element('guest-list');
  const signature = JSON.stringify([
    generatedGuestId,
    state.guestLinks.map((link) => [link, link.expires > Date.now()]),
  ]);
  if (container.dataset.signature === signature) return;
  container.dataset.signature = signature;
  container.replaceChildren();
  for (const link of state.guestLinks) {
    const row = node('div', 'guest-link-row');
    const description = node('div', 'stack');
    description.append(
      node('strong', '', link.label),
      node(
        'small',
        '',
        `${link.scope === 'session' ? 'Entire session · Files and live whitepad' : `Selected items (older link) · ${link.shareIds.length} shares · No whitepad access`} · ${link.expires > Date.now() ? 'Expires' : 'Expired'} ${new Date(link.expires).toLocaleString()}`,
      ),
    );
    row.append(description);
    if (link.id !== generatedGuestId && (link.pinExpires ?? 0) > Date.now())
      row.append(
        button(
          'Show PIN',
          async () => {
            revealId = link.id;
            element<HTMLFormElement>('pin-reveal-form').reset();
            element('pin-reveal-form').hidden = false;
            text('pin-reveal-value', '');
            text('pin-reveal-error', '');
            dialog('pin-dialog').showModal();
            element<HTMLInputElement>('pin-password').focus();
          },
          'secondary',
          undefined,
          'guest-link-error',
        ),
      );
    row.append(
      button(
        'Revoke link',
        async () => {
          await api(`/guest-links/${encodeURIComponent(link.id)}`, 'DELETE');
          if (generatedGuestId === link.id) {
            clearGuestInvitation();
            element('guest-created').hidden = true;
            element('guest-form').hidden = false;
          }
          await refresh();
          text(
            'guest-link-feedback',
            `Revoked "${link.label}". Copies already saved are unchanged.`,
          );
        },
        'danger',
        undefined,
        'guest-link-error',
      ),
    );
    container.append(row);
  }
  if (!state.guestLinks.length)
    container.append(
      node(
        'p',
        'picker-hint',
        'No session links yet. Create one to give someone browser access.',
      ),
    );
}

dialog('pin-dialog').addEventListener('close', () => {
  revealId = '';
  clearTimeout(revealTimer);
  element<HTMLFormElement>('pin-reveal-form').reset();
  text('pin-reveal-value', '');
  text('pin-reveal-error', '');
});
element('pin-reveal-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void action(
    async () => {
      const id = revealId;
      const input = element<HTMLInputElement>('pin-password');
      const password = input.value;
      input.value = '';
      const result = await api<{ pin: string; expires: number }>(
        `/guest-links/${encodeURIComponent(id)}/pin`,
        'POST',
        { password },
      );
      if (!unlocked || revealId !== id || result.expires <= Date.now()) return;
      element('pin-reveal-form').hidden = true;
      text(
        'pin-reveal-value',
        `PIN: ${result.pin} · Use once before ${new Date(result.expires).toLocaleTimeString()}.`,
      );
      revealTimer = setTimeout(
        () => dialog('pin-dialog').close(),
        result.expires - Date.now(),
      );
    },
    element<HTMLButtonElement>('reveal-pin'),
    'pin-reveal-error',
  );
});

onClick('guest-links', async () => {
  await refresh();
  text('guest-link-error', '');
  text('guest-link-feedback', '');
  const lan = state?.access === 'lan';
  text(
    'guest-description',
    lan
      ? 'Join this host from another device on your local network with a 4-digit PIN. Recipients only need a browser.'
      : 'One private link for everything you share in this publisher session. Recipients only need a browser.',
  );
  text(
    'guest-scope-note',
    lan
      ? 'Includes all current and future shared files, folders, and text. Folder shares include hidden and nested files. Access lasts up to 24 hours. Only the latest unused PIN works; creating another does not disconnect guests who already joined.'
      : 'Includes all files, folders, and text you share from this publisher now or later. You can create the link before adding anything. Folder shares include hidden and nested files. Expires in 24 hours; anyone with the link can forward it.',
  );
  text('create-guest', lan ? 'Create PIN' : 'Create session link');
  text('copy-guest', lan ? 'Copy join details' : 'Copy session link');
  text(
    'guest-tunnel-note',
    state?.access === 'lan'
      ? 'Recipients must be on the same reachable local network. This link uses unencrypted HTTP.'
      : state?.guestOrigin
        ? ''
        : 'Start a public tunnel in connection settings before creating a browser guest link.',
  );
  element<HTMLButtonElement>('create-guest').disabled = !state?.guestOrigin;
  element('guest-form').hidden = false;
  element('guest-created').hidden = true;
  renderGuestLinks();
  dialog('guest-dialog').showModal();
});
dialog('guest-dialog').addEventListener('close', () => {
  clearGuestInvitation();
  element<HTMLFormElement>('guest-form').reset();
});
element('guest-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void action(
    async () => {
      const result = await api<{
        id: string;
        url: string;
        joinUrl?: string;
        pin?: string;
        pinExpires?: number;
      }>('/guest-links', 'POST', {
        label: element<HTMLInputElement>('guest-label').value,
      });
      clearGuestInvitation();
      if (state?.access === 'lan') {
        if (!result.joinUrl || !result.pin || !result.pinExpires)
          throw new Error('The host did not return a LAN join PIN.');
        element<HTMLInputElement>('generated-url').value = result.joinUrl;
        element<HTMLInputElement>('generated-pin').value = result.pin;
        element('guest-pin').hidden = false;
        text(
          'pin-expiry',
          `Use once before ${new Date(result.pinExpires).toLocaleTimeString()}. Access continues after the PIN expires.`,
        );
        text('guest-created-title', 'Your join PIN is ready.');
        text(
          'guest-created-note',
          'Open the address below on the receiving device and enter this PIN. It expires in 5 minutes and works once. Keep it private; anyone with it can join.',
        );
      } else {
        element<HTMLInputElement>('generated-url').value = result.url;
        text('guest-created-title', 'Your session link is ready.');
        text(
          'guest-created-note',
          'Copy it now. The secret URL is shown only once; it is not stored on disk. Keep the publisher and its network connection running; new files and text will appear automatically.',
        );
      }
      generatedGuestId = result.id;
      element('guest-created').hidden = false;
      element('guest-form').hidden = true;
      await refresh();
      text(
        'guest-link-feedback',
        state?.access === 'lan'
          ? 'PIN created. The address stays the same; share the PIN privately.'
          : 'Session link created. Current and future files and text appear automatically. Share it privately.',
      );
    },
    element<HTMLButtonElement>('create-guest'),
    'guest-link-error',
  );
});
onClick(
  'copy-guest',
  async () => {
    const input = element<HTMLInputElement>('generated-url');
    const pin = element<HTMLInputElement>('generated-pin').value;
    if (!navigator.clipboard) {
      input.select();
      throw new Error(
        pin
          ? 'Clipboard unavailable. Copy the address and PIN manually.'
          : 'Clipboard unavailable. The link is selected; copy it manually.',
      );
    }
    await navigator.clipboard.writeText(
      pin ? `${input.value}\nPIN: ${pin}` : input.value,
    );
    text(
      'guest-link-feedback',
      pin ? 'Join details copied.' : 'Guest link copied.',
    );
  },
  'guest-link-error',
);
onClick('another-guest', async () => {
  clearGuestInvitation();
  element('guest-created').hidden = true;
  element('guest-form').hidden = false;
  element<HTMLFormElement>('guest-form').reset();
  renderGuestLinks();
});

element('login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void action(async () => {
    const input = element<HTMLInputElement>('password');
    try {
      csrf = (
        await api<{ csrf: string }>('/login', 'POST', { password: input.value })
      ).csrf;
    } finally {
      input.value = '';
    }
    unlocked = true;
    await refresh();
  }, element<HTMLButtonElement>('unlock'));
});
onClick('nav-shares', async () => switchView('shares'));
onClick('nav-texts', async () => switchView('texts'));
element('whitepad').addEventListener('input', () => {
  padDirty = true;
  text('text-feedback', '');
  padStatus();
  schedulePad();
});
onClick('pad-retry', () => recoverPad(false), 'text-error');
onClick('pad-reload', () => recoverPad(true), 'text-error');
window.addEventListener('beforeunload', (event) => {
  if (padDirty || padSaving || copying) {
    event.preventDefault();
    event.returnValue = '';
  }
});
onClick(
  'copy-text',
  async () => {
    if (!navigator.clipboard)
      throw new Error(
        'Clipboard is unavailable. Use Select text and copy manually.',
      );
    await navigator.clipboard.writeText(
      element<HTMLTextAreaElement>('whitepad').value,
    );
    text('text-feedback', 'Copied to clipboard.');
  },
  'text-error',
);
onClick(
  'select-text',
  async () => {
    const content = element<HTMLTextAreaElement>('whitepad');
    content.focus();
    content.select();
    text('text-feedback', 'Text selected. Use your usual Copy shortcut.');
  },
  'text-error',
);
onClick('dismiss-error', async () => text('error-text', ''));
const dropZone = element('drop-zone');
async function copyFiles(files: File[]): Promise<void> {
  if (!unlocked) throw new Error('Unlock the workspace before dropping files.');
  if (copying) throw new Error('Wait for the current files to finish copying.');
  if (!files.length)
    throw new Error('Drop files here. Use Share something for folders.');
  if (files.some((file) => file.size > 1024 * 1024 * 1024))
    throw new Error(
      'Dropped files must be 1 GiB or smaller. Use Share something to share larger originals.',
    );
  const controller = new AbortController();
  copying = controller;
  element<HTMLButtonElement>('choose-copies').disabled = true;
  element('cancel-copy').hidden = false;
  let count = 0;
  try {
    for (const file of files) {
      text(
        'copy-status',
        `Copying ${count + 1} of ${files.length}: ${file.name}`,
      );
      const response = await fetch(
        `/api/uploads?name=${encodeURIComponent(file.name)}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/octet-stream',
            'x-p2pfs-csrf': csrf,
          },
          body: file,
          signal: controller.signal,
        },
      );
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 401) lock();
        throw new Error(
          result.error ?? `Copy failed (HTTP ${response.status}).`,
        );
      }
      count++;
      await refresh();
    }
    text(
      'notice',
      `${count} ${count === 1 ? 'file' : 'files'} shared as local copies.`,
    );
  } catch (error) {
    throw new Error(
      `${count} ${count === 1 ? 'file' : 'files'} shared. ${controller.signal.aborted ? 'Remaining copies cancelled.' : message(error)}`,
    );
  } finally {
    copying = undefined;
    text('copy-status', '');
    element<HTMLButtonElement>('choose-copies').disabled = false;
    element('cancel-copy').hidden = true;
  }
}
for (const eventName of ['dragover', 'drop'])
  document.addEventListener(eventName, (event) => {
    if ((event as DragEvent).dataTransfer?.types.includes('Files'))
      event.preventDefault();
  });
dropZone.addEventListener('dragover', (event) => {
  if (event.dataTransfer?.types.includes('Files')) {
    event.preventDefault();
    event.dataTransfer.dropEffect = copying ? 'none' : 'copy';
    dropZone.classList.add('dragging');
  }
});
dropZone.addEventListener('dragleave', () =>
  dropZone.classList.remove('dragging'),
);
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragging');
  const items = Array.from(event.dataTransfer?.items ?? []);
  const directories = items.some(
    (item) => item.webkitGetAsEntry?.()?.isDirectory,
  );
  const files = Array.from(event.dataTransfer?.files ?? []);
  void action(async () => {
    if (directories)
      throw new Error(
        'Use Share something to share folders. Drop individual files here.',
      );
    await copyFiles(files);
  });
});
onClick('choose-copies', async () =>
  element<HTMLInputElement>('copy-input').click(),
);
element('copy-input').addEventListener('change', () => {
  const input = element<HTMLInputElement>('copy-input');
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (files.length) void action(() => copyFiles(files));
});
onClick('cancel-copy', async () => copying?.abort());
element('search').addEventListener('input', renderCatalog);
for (const id of ['logout', 'top-lock'])
  onClick(id, async () => {
    if (padDirty || padSaving)
      throw new Error(
        'Wait for the whitepad to save, or resolve its save error before locking.',
      );
    await api('/logout', 'POST');
    lock();
  });
onClick('connections', async () => {
  text('connection-error', '');
  text('connection-feedback', '');
  renderConnection();
  dialog('connection-dialog').showModal();
});
document
  .querySelectorAll<HTMLButtonElement>('[data-close]')
  .forEach((item) =>
    item.addEventListener('click', () => dialog(item.dataset.close!).close()),
  );
onClick(
  'start',
  async () => {
    text(
      'connection-feedback',
      'Starting the connection. This can take a moment…',
    );
    try {
      await api('/tunnel/start', 'POST', {});
      text(
        'connection-feedback',
        'Tunnel started. Your selected shares are reachable.',
      );
    } finally {
      await refresh();
      if (!state?.tunnel.url) text('connection-feedback', '');
    }
  },
  'connection-error',
);
onClick(
  'stop',
  async () => {
    await api('/tunnel/stop', 'POST');
    text(
      'connection-feedback',
      'Tunnel stopped. Local shares remain configured.',
    );
    await refresh();
  },
  'connection-error',
);
onClick('add-share', async () => {
  text('picker-error', '');
  dialog('picker-dialog').showModal();
  await browseLocal();
});
dialog('picker-dialog').addEventListener('close', () => {
  pickerVersion++;
  pickerLoading = false;
});
element('picker-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void browseLocal(element<HTMLInputElement>('picker-path').value);
});
onClick('picker-home', () => browseLocal(), 'picker-error');
element('picker-up').addEventListener('click', () => {
  if (listing?.parent) void browseLocal(listing.parent);
});
element('picker-hidden').addEventListener(
  'change',
  () => void browseLocal(element<HTMLInputElement>('picker-path').value),
);
onClick(
  'picker-share',
  async () => {
    if (!listing || pickerLoading) return;
    await api('/shares', 'POST', { path: listing.selected ?? listing.path });
    dialog('picker-dialog').close();
    await refresh();
    text(
      'notice',
      'Share added. Session-link recipients have read-only access while your connection is live.',
    );
  },
  'picker-error',
);
onClick(
  'confirm-revoke',
  async () => {
    await api(`/shares/${revokeId}`, 'DELETE');
    dialog('revoke-dialog').close();
    await refresh();
    text('notice', 'Share revoked. Your original files are unchanged.');
  },
  'revoke-error',
);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && unlocked) queueLive();
});
void action(async () => {
  const session = await api<{ csrf: string | null }>('/csrf');
  if (!session.csrf) return;
  csrf = session.csrf;
  unlocked = true;
  await refresh();
});
