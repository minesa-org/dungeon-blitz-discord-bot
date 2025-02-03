import { SlashCommandBuilder } from "discord.js";
import { getLastClaimed, giveDailyReward } from "../../shortcuts/database.js";
import { coins, experience } from "../../shortcuts/emojis.js";

export default {
    data: new SlashCommandBuilder()
        .setName("daily")
        .setDescription("Claim your daily reward!"),
    execute: async ({ interaction }) => {
        const userId = interaction.user.id;
        const username = interaction.user.username; // username bilgisini de ekliyoruz
        const lastClaimed = await getLastClaimed(userId, username);
        const now = Date.now();

        if (lastClaimed && now - lastClaimed < 24 * 60 * 60 * 1000) {
            const timeLeft = 24 * 60 * 60 * 1000 - (now - lastClaimed);
            const timestamp = Math.floor((now + timeLeft) / 1000);

            await interaction.reply(
                `You can claim your next daily reward at <t:${timestamp}:R>.`
            );
        } else {
            await giveDailyReward(userId, username);
            await interaction.reply(
                `> You have claimed ${coins} 1000 coins & ${experience} 500 exp as reward, keep it up! ☺︎`
            );
        }
    },
};
