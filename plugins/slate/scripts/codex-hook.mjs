import { main } from './hook.mjs';

await main(process.argv[2], { ...process.env, SLATE_RUNTIME: 'codex' });
