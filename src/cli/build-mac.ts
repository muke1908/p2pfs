import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { defaultStateDir } from '../config/state.js';

const cli = new Command()
  .description('Build the native p2pfs menu-bar app (no login service)')
  .option('--state-dir <path>', 'Publisher state directory', defaultStateDir())
  .parse();
if (process.platform !== 'darwin')
  throw new Error(
    'Building the app requires macOS and Xcode Command Line Tools.',
  );
const root = fileURLToPath(new URL('../../../', import.meta.url));
const app = path.join(root, 'dist', 'p2pfs.app');
const contents = path.join(app, 'Contents');
await mkdir(path.join(contents, 'MacOS'), { recursive: true });
await mkdir(path.join(contents, 'Resources'), { recursive: true });
await writeFile(
  path.join(contents, 'Resources', 'host.json'),
  JSON.stringify({
    node: process.execPath,
    root,
    path: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    stateDirectory: path.resolve(cli.opts<{ stateDir: string }>().stateDir),
  }),
);
await writeFile(
  path.join(contents, 'Info.plist'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>p2pfs</string>
<key>CFBundleIdentifier</key><string>io.github.muke1908.p2pfs.app</string>
<key>CFBundleName</key><string>p2pfs</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`,
);
await promisify(execFile)('xcrun', [
  'swiftc',
  '-O',
  '-swift-version',
  '5',
  '-target',
  `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`,
  '-framework',
  'AppKit',
  path.join(root, 'macos', 'HostSession.swift'),
  path.join(root, 'macos', 'main.swift'),
  '-o',
  path.join(contents, 'MacOS', 'p2pfs'),
]);
await promisify(execFile)('codesign', ['--force', '--sign', '-', app]);
console.log(
  `Built ${app}\nOpen it when ready to start sharing. No login item or background service was installed.`,
);
