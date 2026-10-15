const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, Events } = require('discord.js');

let fileConfig = {};
try {
    fileConfig = JSON.parse(fs.readFileSync(__dirname + '/config.json', 'utf8'));
} catch (e) {
    fileConfig = {};
}

const config = {
    botToken: process.env.BOT_TOKEN || fileConfig.botToken,
    guildId: process.env.GUILD_ID || fileConfig.guildId || "1560263768791851048",
    discordInvite: process.env.DISCORD_INVITE || fileConfig.discordInvite || "https://discord.gg/REc49nm87",
    githubToken: process.env.GITHUB_TOKEN || fileConfig.githubToken,
    githubOwner: process.env.GITHUB_OWNER || fileConfig.githubOwner || "joelabonite16-web",
    githubRepo: process.env.GITHUB_REPO || fileConfig.githubRepo || "keys",
    githubPath: process.env.GITHUB_PATH || fileConfig.githubPath || "keys.json",
    port: process.env.PORT || 8000
};

const port = config.port;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: "online", service: "Discord Whitelist Bot" }));
}).listen(port, () => {
    console.log(`Koyeb health check server listening on port ${port}`);
});

async function getGitHubKeys() {
    const url = `https://api.github.com/repos/${config.githubOwner}/${config.githubRepo}/contents/${config.githubPath}`;
    const res = await fetch(url, {
        headers: {
            'Authorization': `token ${config.githubToken}`,
            'User-Agent': 'Discord-Whitelist-Bot',
            'Accept': 'application/vnd.github.v3+json'
        }
    });
    if (!res.ok) {
        throw new Error(`Failed to fetch keys.json: ${res.statusText}`);
    }
    const data = await res.json();
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    let json = {};
    try {
        json = JSON.parse(content);
    } catch (e) {
        json = {};
    }
    return { keys: json, sha: data.sha };
}

async function updateGitHubKeys(keys, sha, commitMsg) {
    const url = `https://api.github.com/repos/${config.githubOwner}/${config.githubRepo}/contents/${config.githubPath}`;
    const base64Content = Buffer.from(JSON.stringify(keys, null, 2)).toString('base64');
    const res = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': `token ${config.githubToken}`,
            'User-Agent': 'Discord-Whitelist-Bot',
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            message: commitMsg || 'Update whitelist keys',
            content: base64Content,
            sha: sha
        })
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Failed to commit keys.json: ${err}`);
    }
    const data = await res.json();
    return data.content.sha;
}

function generateKey() {
    const part1 = crypto.randomBytes(3).toString('hex').toUpperCase();
    const part2 = crypto.randomBytes(3).toString('hex').toUpperCase();
    const part3 = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `KEY-${part1}-${part2}-${part3}`;
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

const commands = [
    new SlashCommandBuilder()
        .setName('getkey')
        .setDescription('Get your access key for the Hub')
        .addStringOption(option =>
            option.setName('roblox_username')
                .setDescription('Your Roblox username')
                .setRequired(false)
        )
].map(command => command.toJSON());

async function registerCommands() {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) {
        console.log(`[Notice] Waiting for guild ${config.guildId}...`);
        return false;
    }
    const rest = new REST({ version: '10' }).setToken(config.botToken);
    try {
        console.log(`Registering slash commands for ${guild.name} (${guild.id})...`);
        await rest.put(
            Routes.applicationGuildCommands(client.user.id, config.guildId),
            { body: commands }
        );
        console.log('Slash commands registered successfully!');
        return true;
    } catch (error) {
        console.error('Error registering slash commands:', error.message);
        return false;
    }
}

client.once(Events.ClientReady, async () => {
    console.log(`Bot logged in as ${client.user.tag}`);
    await registerCommands();
});

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'getkey') {
        const robloxUsername = interaction.options.getString('roblox_username') || "Player";
        const discordId = interaction.user.id;

        await interaction.deferReply({ flags: 64 });

        try {
            const { keys, sha } = await getGitHubKeys();

            let existingKey = null;
            for (const [k, v] of Object.entries(keys)) {
                if (v && v.discordId === discordId) {
                    existingKey = k;
                    break;
                }
            }

            const userKey = existingKey || generateKey();
            keys[userKey] = {
                discordId: discordId,
                robloxUsername: robloxUsername,
                updatedAt: new Date().toISOString()
            };

            await updateGitHubKeys(keys, sha, `Add key for ${interaction.user.tag} (${userKey})`);

            return interaction.editReply({
                content: `**Your Access Key:**\n\`\`\`\n${userKey}\n\`\`\`\nCopy and paste this key into the script in Roblox.\n*Note: Your key is synchronized with Discord. If you leave this Discord server, your key will be automatically revoked.*`
            });
        } catch (err) {
            console.error('Error processing /getkey:', err);
            return interaction.editReply({
                content: `An error occurred while generating your key: ${err.message}. Please notify the server owner.`
            });
        }
    }
});

client.on(Events.GuildMemberRemove, async member => {
    if (member.guild.id !== config.guildId) return;
    try {
        const { keys, sha } = await getGitHubKeys();
        let changed = false;
        let removedKey = null;
        for (const [k, v] of Object.entries(keys)) {
            if (v && v.discordId === member.id) {
                removedKey = k;
                delete keys[k];
                changed = true;
            }
        }
        if (changed) {
            await updateGitHubKeys(keys, sha, `Revoke key for departed member ${member.user.tag} (${removedKey})`);
            console.log(`Revoked key ${removedKey} for departed member ${member.user.tag}`);
        }
    } catch (err) {
        console.error('Error auto-revoking key on member leave:', err);
    }
});

if (config.botToken) {
    client.login(config.botToken).catch(err => {
        console.error("Failed to login to Discord:", err.message);
    });
}
