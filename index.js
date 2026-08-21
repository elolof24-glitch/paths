import 'dotenv/config';
import { startDiscord } from './src/discord.js';

console.log('[startup] starting Discord bot');

await startDiscord();
