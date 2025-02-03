import mongoose from "mongoose";
import { TOKEN, DATABASE_URI } from "../config.js";
import {
    ActivityType,
    Client,
    Collection,
    GatewayIntentBits,
    Status,
} from "discord.js";
import fs from "fs";

async function connectToMongoDB() {
    try {
        await mongoose.connect(DATABASE_URI);
        console.log("[Database]: MongoDB connection successful!");
    } catch (error) {
        console.error("[Database]: MongoDB connection failed!", error);
        process.exit(1);
    }
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
    ],
    presence: {
        status: Status.Idle,
        activities: [
            {
                name: "Dungeon Blitz: Remake #gathering",
                type: ActivityType.Playing,
                url: "https://blitzforge-studios.github.io/dbr-demo/",
                state: "Play demo with Discord's App Launcher.",
            },
        ],
    },
});

client.commands = new Collection();
client.buttons = new Collection();
client.selectMenus = new Collection();
client.modals = new Collection();
client.commandArray = [];

async function loadFunctions() {
    const functionFolders = fs.readdirSync("./src/functions");

    for (const folder of functionFolders) {
        const functionFiles = fs
            .readdirSync(`./src/functions/${folder}`)
            .filter((file) => file.endsWith(".js"));

        for (const file of functionFiles) {
            try {
                const { default: func } = await import(
                    `./functions/${folder}/${file}`
                );
                func(client);
                console.log(`[Functions]: Loaded ${file}`);
            } catch (error) {
                console.error(`Error loading function ${file}:`, error);
            }
        }
    }
}

async function initializeBot() {
    await connectToMongoDB();
    await loadFunctions();

    client.handleCommands();
    client.handleEvents();
    client.handleComponents();

    try {
        await client.login(TOKEN);
        console.log("[Bot]: Bot başarıyla giriş yaptı!");
    } catch (error) {
        console.error("[Bot]: Error logging in:", error);
    }
}

initializeBot();
