import dotenv from "dotenv";
dotenv.config();

if (!process.env.DISCORD_BOT_TOKEN) {
	console.log("⚠️ DISCORD_BOT_TOKEN not found. Skipping command registration.");
	process.exit(0);
}

const { mini } = await import("../api/interactions");

const response = await fetch(
	`https://discord.com/api/v10/applications/${mini.applicationId}/commands`,
	{
		method: "PUT",
		headers: {
			Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: "[]",
	},
);

if (!response.ok) {
	throw new Error(
		`[register] Failed to clear application commands: [${response.status}] ${await response.text()}`,
	);
}

console.log("Command registration reset complete!");
