import {
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
    .setName('check')
    .setDescription('Check all monitored targets now')
].map(command => command.toJSON());

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

async function sendResults(target, results) {
  if (!results.length) return;

  const channel = await alertChannel();
  const lines = results.slice(0, 20).map(result => {
    const icon = result.type === 'new' ? '🆕' : '🟠';
    const label = result.type === 'new' ? 'New path' : 'Path changed';
    return `${icon} **${label}** — <${result.url}> (${result.status ?? 'unknown'})`;
  });

  const mention = config.alertRoleId ? `<@&${config.alertRoleId}> ` : '';

  await channel.send({
    content: `${mention}**${target.name}**\n${lines.join('\n')}`,
    allowedMentions: {
      roles: config.alertRoleId ? [config.alertRoleId] : []
    }
  });
}

export async function checkAll() {
  for (const target of getTargets()) {
    try {
      const results = await scanPaths(target);
      await sendResults(target, results);
      console.log(`${target.name}: ${results.length} new or changed path(s)`);
    } catch (error) {
      console.error(`${target.name}: ${error.message}`);
    }
  }
}

export async function startDiscord() {
  client.once('ready', async () => {
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

      if (interaction.commandName === 'watchlist') {
        const targets = getTargets();
        return interaction.reply({
          content: targets.length
            ? targets.map(target => `• **${target.name}** — <${target.url}>`).join('\n')
            : 'No path targets are being monitored.',
          ephemeral: true
        });
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
