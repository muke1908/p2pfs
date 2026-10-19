import type { SharedFile } from './service.js';

export function addPreview(
  container: HTMLElement,
  file: SharedFile,
  url: string,
): void {
  if (!file.preview) return;
  const link = document.createElement('a');
  link.className = 'image-preview';
  link.href = `${url}/image`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.title = 'Open full-size image in a new tab';
  link.setAttribute('aria-label', `Open ${file.name} full size in a new tab`);
  const image = document.createElement('img');
  image.className = 'thumbnail';
  image.width = 96;
  image.height = 96;
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.addEventListener('load', () => {
    container.classList.add('has-preview');
  });
  image.addEventListener('error', () => {
    link.remove();
    container.title =
      'Preview unavailable. The original file can still be downloaded.';
  });
  image.src = `${url}/preview`;
  link.append(image);
  container.prepend(link);
}
