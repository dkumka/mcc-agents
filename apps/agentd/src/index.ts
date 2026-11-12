import { ClaudeAdapter } from './claude/index.ts';
import { CodexAdapter } from './codex/index.ts';
import { Hub } from './hub.ts';
import { logger } from './log.ts';
import { startServer } from './server.ts';
import { flushStore, loadStore } from './store.ts';

const log = logger('agentd');

loadStore();
const hub = new Hub();
const claude = new ClaudeAdapter(hub);
const codex = new CodexAdapter(hub);
hub.register(claude);
hub.register(codex);
codex.start();

startServer(hub);

hub.refresh().catch((e) => log.warn('initial refresh', e));
setInterval(() => hub.refresh().catch(() => {}), 10_000);
setInterval(() => hub.sweep(), 60_000);

function shutdown(sig: string) {
  log.info(`${sig}: shutting down`);
  flushStore();
  hub.shutdown();
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => log.error('uncaught', e));
process.on('unhandledRejection', (e) => log.error('unhandled rejection', e));
