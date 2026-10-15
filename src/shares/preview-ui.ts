import type { SharedFile } from './service.js';

export function addPreview(
  container: HTMLElement,
  file: SharedFile,
  url: string,
): void {
  if (!file.preview) return;
  const image = document.createElement('img');
  image.className = 'thumbnail';
  image.width = 48;
  image.height = 48;
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.addEventListener('load', () => {
    container.classList.add('has-preview');
  });
  image.addEventListener('error', () => {
    image.remove();
    container.title =
      'Preview unavailable. The original file can still be downloaded.';
  });
  image.src = url;
  container.prepend(image);
}
