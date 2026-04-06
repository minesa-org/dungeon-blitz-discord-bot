const DEFAULT_REDIRECT_URI =
	"https://discord-github-assistant-bot.vercel.app/api/discord-oauth-callback";
const configuredRedirectUri = process.env.DISCORD_REDIRECT_URI;
const redirectUri =
	configuredRedirectUri && !configuredRedirectUri.includes("localhost")
		? configuredRedirectUri
		: DEFAULT_REDIRECT_URI;

export const discordOAuthConfig = {
	appId:
		process.env.DISCORD_APPLICATION_ID ??
		process.env.DISCORD_CLIENT_ID ??
		"",
	appSecret: process.env.DISCORD_CLIENT_SECRET ?? "",
	redirectUri,
};
