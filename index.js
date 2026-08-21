import 'dotenv/config';
import { startDiscord } from './src/discord.js';

console.log('[startup] index.js loaded');

if (!process.env.DISCORD_TOKEN) {
  throw new Error('DISCORD_TOKEN is missing in Railway Variables');
}

try {
  await startDiscord();
  console.log('[startup] Discord client started');
} catch (error) {
  console.error('[startup] Discord startup failed:', error);
  process.exit(1);
}
