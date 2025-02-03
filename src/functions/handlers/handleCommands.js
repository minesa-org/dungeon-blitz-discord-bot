import {
    ContextMenuCommandBuilder,
    REST,
    Routes,
    SlashCommandBuilder,
} from "discord.js";
import { promises as fs } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { TOKEN, CLIENT_ID } from "../../../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default async (client) => {
    client.handleCommands = async () => {
        const commandFolders = await fs.readdir(`${__dirname}/../../commands`);

        for (const folder of commandFolders) {
            const commandFiles = (
                await fs.readdir(`${__dirname}/../../commands/${folder}`)
            ).filter((file) => file.endsWith(".js"));
            const { commands, commandArray } = client;

            for (const file of commandFiles) {
                const { default: command } = await import(
                    `../../commands/${folder}/${file}`
                );
                commands.set(command.data.name, command);
                if (
                    command.data instanceof SlashCommandBuilder ||
                    command.data instanceof ContextMenuCommandBuilder
                ) {
                    commandArray.push(command.data.toJSON());
                } else {
                    commandArray.push(command.data);
                }

                console.log(`[Commands]: Loaded ${command.data.name} command.`);
            }
        }
        const clientId = CLIENT_ID;
        const rest = new REST({ version: "10" }).setToken(TOKEN);

        try {
            console.log(
                `[Commands] Started refreshing application (/) commands.`
            );

            // Try to update the commands
            await rest.put(Routes.applicationCommands(clientId), {
                body: client.commandArray,
            });

            console.log(
                `[Commands] Successfully reloaded application (/) commands.`
            );
        } catch (error) {
            // Suppress the error and log it without crashing
            if (error.code !== 50240) {
                // Ignore 50240 errors (Entry Point errors)
                console.error("Error while updating commands:", error);
            } else {
                console.log("Ignored Entry Point update error.");
            }
        }
    };
};
