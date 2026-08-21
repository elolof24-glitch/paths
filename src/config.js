import 'dotenv/config';

const required = [
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_GUILD_ID',
  'DISCORD_ALERT_CHANNEL_ID'
];

for (const name of required) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

export const config = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  guildId: process.env.DISCORD_GUILD_ID,
  alertChannelId: process.env.DISCORD_ALERT_CHANNEL_ID,
  alertRoleId: process.env.DISCORD_ALERT_ROLE_ID || '',
  pollSeconds: Math.max(300, Number(process.env.POLL_SECONDS || 900)),
  databasePath: process.env.DATABASE_PATH || './data/v2.sqlite'
};
