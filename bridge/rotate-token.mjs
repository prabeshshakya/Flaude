// npm run rotate-token: issues a new bridge token. Paste the new one into the plugin.
import { unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const f = path.join(path.dirname(fileURLToPath(import.meta.url)), '.bridge-token');
if (existsSync(f)) unlinkSync(f);
console.log('Old token removed. Start the bridge (npm start) to get a new one, then paste it into the plugin settings.');
