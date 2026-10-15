#!/usr/bin/env node
import path from 'node:path';
import { unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const filename = fileURLToPath(import.meta.url);
const scenario = path.basename(filename);
const args = process.argv.slice(2);
if (args[0] === '--version' || args[0] === 'version') {
  if (scenario.includes('slow'))
    await new Promise((resolve) => setTimeout(resolve, 2000));
  console.log('Synthetic tunnel CLI 1.0');
} else if (args[0] === 'user') {
  if (scenario.includes('disappear')) await unlink(filename);
  console.log('Logged in (synthetic fixture)');
} else if (args.includes('--help')) {
  console.log('--headless --force-local --open');
} else if (scenario.includes('exit')) {
  process.exitCode = 2;
} else {
  await writeFile(`${filename}.pid`, String(process.pid));
  const output =
    args[0] === 'host'
      ? `Hosting port ${args[args.indexOf('-p') + 1]} at https://fixture.example.com/\n`
      : 'access your zrok share at the following endpoints:\n https://fixture.example.com\n';
  process.stdout.write(output.slice(0, 25));
  setTimeout(() => process.stdout.write(output.slice(25)), 20);
  setInterval(() => {}, 1000);
}
