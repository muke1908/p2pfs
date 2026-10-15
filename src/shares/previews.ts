import sharp from 'sharp';
import { AppError } from '../security/auth.js';
import type { Shares } from './service.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function hasPreview(name: string, size: number): boolean {
  return (
    size > 0 &&
    size <= MAX_IMAGE_BYTES &&
    /\.(jpe?g|png|webp|gif|avif|tiff?)$/i.test(name)
  );
}

export class Previews {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(private shares: Shares) {}

  async create(shareId: string, fileId: string): Promise<Buffer> {
    if (this.waiting.length >= 100)
      throw new AppError(429, 'Image previews are busy; try again shortly.');
    if (this.active >= 2)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      const { file, stream } = await this.shares.stream(shareId, fileId);
      try {
        if (!hasPreview(file.name, file.size))
          throw new AppError(415, 'No preview available for this file.');
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of stream) {
          const data = Buffer.from(chunk);
          length += data.length;
          if (length > MAX_IMAGE_BYTES)
            throw new AppError(413, 'Image is too large for a preview.');
          chunks.push(data);
        }
        try {
          const image = sharp(Buffer.concat(chunks), {
            limitInputPixels: 40_000_000,
            animated: false,
          }).timeout({ seconds: 5 });
          const metadata = await image.metadata();
          if (
            !['jpeg', 'png', 'webp', 'gif', 'heif', 'tiff'].includes(
              metadata.format,
            )
          )
            throw new Error('Unsupported image format.');
          const preview = await image
            .rotate()
            .resize(128, 128, {
              fit: 'inside',
              withoutEnlargement: true,
            })
            .webp({ quality: 70 })
            .toBuffer();
          this.shares.requireFile(shareId, fileId);
          return preview;
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError(
            415,
            'Image preview unavailable; download the original instead.',
          );
        }
      } finally {
        stream.destroy();
      }
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
