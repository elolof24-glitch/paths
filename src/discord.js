import {
  AttachmentBuilder,
  ChannelType,
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder
} from 'discord.js';
import { config } from './config.js';
import {
  disableTarget,
  getStoredPaths,
  getTargets,
  upsertTarget
} from './database.js';
import { scanPaths } from './path-watcher.js';

export const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

export const commands = [
  new SlashCommandBuilder()
    .setName('watch-path')
    .setDescription('Monitor URL paths on one exact hostname')
    .addStringOption(option => option.setName('name').setDescription('Target name').setRequired(true))
    .addStringOption(option => option.setName('url').setDescription('Example: https://binance.com').setRequired(true)),
  new SlashCommandBuilder()
    .setName('unwatch')
    .setDescription('Stop monitoring a target')
    .addStringOption(option => option.setName('name').setDescription('Target name').setRequired(true)),
  new SlashCommandBuilder()
    .setName('watchlist')
    .setDescription('List monitored targets'),
  new SlashCommandBuilder()
    .setName('path')
    .setDescription('List currently monitored path targets'),
  new SlashCommandBuilder()
    .setName('scan2')
    .setDescription('Export all stored URL paths as text'),
  new SlashCommandBuilder()
    .setName('testalert2')
    .setDescription('Send a test new-path alert'),
  new SlashCommandBuilder()
    .setName('check')
    .setDescription('Check all monitored targets now')
].map(command => command.toJSON());

function parisTime(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris',
    dateStyle: 'full',
    timeStyle: 'medium',
    hour12: false
  }).format(date);
}

function timeAgo(date) {
  const now = new Date();
  const diff = Math.floor((now - date) / 1000); // seconds
  
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  return `${Math.floor(diff / 2592000)}mo ago`;
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.token);
  await rest.put(
    Routes.applicationGuildCommands(config.clientId, config.guildId),
    { body: commands }
  );
}

async function alertChannel() {
  const guild = await client.guilds.fetch(config.guildId);
  const channel = await guild.channels.fetch(config.alertChannelId);

  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error('Alert channel must be a text channel');
  }

  const permissions = channel.permissionsFor(client.user);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel)) throw new Error('Missing View Channel permission');
  if (!permissions.has(PermissionFlagsBits.SendMessages)) throw new Error('Missing Send Messages permission');

  return channel;
}

function pathFile(target, paths) {
  const header = [
    `URL path scan for ${target.name}`,
    `Base URL: ${target.url}`,
    `Generated: ${parisTime()}`,
    `Total paths: ${paths.length}`,
    '',
    'Paths:',
    ''
  ].join('\n');

  const body = paths.map(item => {
    const age = item.discoveredAt ? timeAgo(new Date(item.discoveredAt)) : 'unknown';
    return `${item.url} (${age})`;
  }).join('\n');
  
  return Buffer.from(`${header}${body}\n`, 'utf8');
}

async function sendResults(target, results) {
  if (!results.length) return;

  const channel = await alertChannel();
  const lines = results.slice(0, 20).map(result => {
    const icon = result.type === 'new' ? '🆕' : '🟠';
    const label = result.type === 'new' ? 'New path' : 'Path changed';
    const age = result.discoveredAt ? timeAgo(new Date(result.discoveredAt)) : 'just now';
    return `${icon} **${label}** — <${result.url}> (${result.status ?? 'unknown'}, ${age})`;
  });

  const mention = config.alertRoleId ? `<@&${config.alertRoleId}> ` : '';

  await channel.send({
    content: `${mention}**${target.name}**\n${lines.join('\n')}`,
    allowedMentions: {
      roles: config.alertRoleId ? [config.alertRoleId] : []
    }
  });
}

async function sendTestAlert() {
  const channel = await alertChannel();
  const mention = config.alertRoleId ? `<@&${config.alertRoleId}> ` : '';

  await channel.send({
    content: `${mention}🧪 **Test new URL path alert**\n🆕 **New path** — <https://example.com/test-new-path>`,
    allowedMentions: {
      roles: config.alertRoleId ? [config.alertRoleId] : []
    }
  });
}

export async function checkAll() {
  console.log('[scan] starting all scans');
  
  for (const target of getTargets()) {
    try {
      console.log(`[scan] starting ${target.name}`);
      const results = await scanPaths(target);
      
      if (results.changes && results.changes.length > 0) {
        await sendResults(target, results.changes);
      }
      
      console.log(`${target.name}: ${results.changes?.length || 0} new or changed path(s)`);
    } catch (error) {
      console.error(`${target.name}: ${error.message}`);
      console.error(error.stack);
    }
  }
  
  console.log('[scan] all scans completed');
}

export async function startDiscord() {
  client.once('clientReady', async () => {
    await registerCommands();
    console.log(`Logged in as ${client.user.tag}`);
    await checkAll();
    setInterval(checkAll, config.pollSeconds * 1000);
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    try {
      if (interaction.commandName === 'watch-path') {
        const name = interaction.options.getString('name').trim();
        const input = interaction.options.getString('url').trim();
        const parsed = new URL(input);

        if (!['http:', 'https:'].includes(parsed.protocol)) {
          throw new Error('Only HTTP and HTTPS URLs are supported');
        }

        parsed.hash = '';
        parsed.search = '';
        upsertTarget(name, parsed.toString());

        return interaction.reply({
          content: `Monitoring paths on **${parsed.hostname}** as **${name}**.`,
          ephemeral: true
        });
      }

      if (interaction.commandName === 'unwatch') {
        const name = interaction.options.getString('name').trim();
        disableTarget(name);
        return interaction.reply({ content: `Stopped **${name}**.`, ephemeral: true });
      }

      if (interaction.commandName === 'watchlist' || interaction.commandName === 'path') {
        const targets = getTargets();
        return interaction.reply({
          content: targets.length
            ? [
                '**Currently monitored path targets**',
                ...targets.map(target => `• **${target.name}** — <${target.url}>`)
              ].join('\n')
            : 'No websites are currently monitored.',
          ephemeral: true
        });
      }

      if (interaction.commandName === 'scan2') {
        await interaction.deferReply({ ephemeral: true });

        const targets = getTargets();
        if (!targets.length) {
          return interaction.editReply('No websites are currently monitored.');
        }

        const files = targets.map(target => {
          const paths = getStoredPaths(target.id);
          return new AttachmentBuilder(
            pathFile(target, paths),
            { name: `${target.name}-paths.txt` }
          );
        });

        return interaction.editReply({
          content: `Exported all stored URL paths for ${targets.length} monitored target(s).`,
          files
        });
      }

      if (interaction.commandName === 'testalert2') {
        await interaction.deferReply({ ephemeral: true });
        await sendTestAlert();
        return interaction.editReply('Test new-path alert sent.');
      }

      if (interaction.commandName === 'check') {
        await interaction.deferReply({ ephemeral: true });
        await checkAll();
        return interaction.editReply('Path checks completed.');
      }
    } catch (error) {
      console.error(error);
      const message = `Error: ${error.message}`;

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(message);
      } else {
        await interaction.reply({ content: message, ephemeral: true });
      }
    }
  });

  await client.login(config.token);
}
