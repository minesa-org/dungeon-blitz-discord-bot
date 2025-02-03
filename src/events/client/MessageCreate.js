import { Events } from "discord.js";
import { handleUserMessage } from "../../shortcuts/database.js";

const COOLDOWN_TIME = 3000;
const EXP_PER_MESSAGE = 10;

export default {
    name: Events.MessageCreate,
    once: false,
    execute: async (message) => {
        if (message.author.bot || !message.guild) return;

        const userId = message.author.id;
        const username = message.author.username;

        try {
            const result = await handleUserMessage(
                userId,
                username,
                EXP_PER_MESSAGE,
                COOLDOWN_TIME
            );

            if (result.success && result.leveledUp) {
                console.log(
                    `${username} has leveled up to level ${result.currentLevel}!`
                );
            }
        } catch (error) {
            console.error("Error handling user message:", error);
        }
    },
};
