import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
if (existsSync(path.join(root, '.att-mail-installed.json'))) {
  throw new Error(
    'This is an installed mail runtime. Build and test only in the development repository.',
  );
}
