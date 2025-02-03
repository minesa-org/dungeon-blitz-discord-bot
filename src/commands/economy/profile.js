import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { coins, experience } from "../../shortcuts/emojis.js";
import { getUserBalance, getUserExp } from "../../shortcuts/database.js";
import { EMBED_COLOR } from "../../../config.js";

const LEVELS = [
    { level: 1, expRequired: 100 },
    { level: 2, expRequired: 260 },
    { level: 3, expRequired: 450 },
    { level: 4, expRequired: 680 },
    { level: 5, expRequired: 1000 },
    { level: 6, expRequired: 1380 },
    { level: 7, expRequired: 1820 },
    { level: 8, expRequired: 2400 },
    { level: 9, expRequired: 3150 },
    { level: 10, expRequired: 4000 },
    { level: 11, expRequired: 5060 },
    { level: 12, expRequired: 6360 },
    { level: 13, expRequired: 7930 },
    { level: 14, expRequired: 9800 },
    { level: 15, expRequired: 12000 },
    { level: 16, expRequired: 14720 },
    { level: 17, expRequired: 18020 },
    { level: 18, expRequired: 21780 },
    { level: 19, expRequired: 26410 },
    { level: 20, expRequired: 32000 },
    { level: 21, expRequired: 38640 },
    { level: 22, expRequired: 46420 },
    { level: 23, expRequired: 55890 },
    { level: 24, expRequired: 66960 },
    { level: 25, expRequired: 80000 },
    { level: 26, expRequired: 95680 },
    { level: 27, expRequired: 113940 },
    { level: 28, expRequired: 135800 },
    { level: 29, expRequired: 161530 },
    { level: 30, expRequired: 192000 },
    { level: 31, expRequired: 227850 },
    { level: 32, expRequired: 270080 },
    { level: 33, expRequired: 320100 },
    { level: 34, expRequired: 378760 },
    { level: 35, expRequired: 448000 },
    { level: 36, expRequired: 529200 },
    { level: 37, expRequired: 624930 },
    { level: 38, expRequired: 737200 },
    { level: 39, expRequired: 869310 },
    { level: 40, expRequired: 1024000 },
    { level: 41, expRequired: 1205810 },
    { level: 42, expRequired: 1418760 },
    { level: 43, expRequired: 1668400 },
    { level: 44, expRequired: 1961080 },
    { level: 45, expRequired: 2304000 },
    { level: 46, expRequired: 2705260 },
    { level: 47, expRequired: 3175320 },
    { level: 48, expRequired: 3724800 },
    { level: 49, expRequired: 4367860 },
    { level: 50, expRequired: Infinity },
];

function getLevelDetails(exp) {
    for (let i = 0; i < LEVELS.length; i++) {
        if (exp < LEVELS[i].expRequired) {
            const currentLevel = LEVELS[i - 1] || LEVELS[0];
            const nextLevel = LEVELS[i];
            const progress = exp - (currentLevel.expRequired || 0);
            const expNeeded = nextLevel.expRequired - (currentLevel.expRequired || 0);
            return {
                level: currentLevel.level,
                nextLevelExp: expNeeded,
                progress,
            };
        }
    }
}

export default {
    data: new SlashCommandBuilder()
        .setName("profile")
        .setDescription("View your profile or someone else's profile")
        .addUserOption((option) =>
            option
                .setName("user")
                .setDescription("The user to view the profile of")
                .setRequired(false)
        ),
    execute: async ({ interaction }) => {
        const targetUser = interaction.options.getUser("user") || interaction.user;
        const targetMember = interaction.guild.members.cache.get(targetUser.id);

        // getUserBalance ve getUserExp fonksiyonlarına username bilgisini de gönderiyoruz.
        const balance = await getUserBalance(targetUser.id, targetUser.username);
        const exp = await getUserExp(targetUser.id, targetUser.username);
        const { level, nextLevelExp, progress } = getLevelDetails(exp);

        const embed = new EmbedBuilder()
            .setTitle("Profile")
            .setDescription(
                targetUser.id === interaction.user.id
                    ? `${interaction.member.displayName}, let's check out your profile.`
                    : `You are viewing ${targetMember.displayName}'s profile.`
            )
            .addFields(
                {
                    name: "Coins",
                    value: `${coins} ${balance} coins`,
                    inline: true,
                },
                {
                    name: "Gems",
                    value: "0 gems",
                    inline: true,
                },
                {
                    name: "\u200b",
                    value: "\u200b",
                    inline: true,
                },
                {
                    name: "Experience",
                    value: `${experience} ${progress} / ${nextLevelExp} exp`,
                    inline: true,
                },
                {
                    name: "Level",
                    value: `**${level}**`,
                    inline: true,
                },
                {
                    name: "\u200b",
                    value: "\u200b",
                    inline: true,
                }
            )
            .setColor(EMBED_COLOR)
            .setThumbnail(targetUser.displayAvatarURL());

        await interaction.reply({ embeds: [embed] });
    },
};
