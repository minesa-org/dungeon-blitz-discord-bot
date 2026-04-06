import { MiniDatabase } from "@minesa-org/mini-interaction";
import { mini } from "./interactions.js";
import { updateDiscordMetadata } from "../src/utils/database.js";
import { discordOAuthConfig } from "../src/utils/oauthConfig.js";

const database = MiniDatabase.fromEnv();
const failedPage = mini.failedOAuthPage("pages/failed.html");

export default mini.discordOAuthCallback({
	oauth: discordOAuthConfig,
	templates: {
		success: mini.connectedOAuthPage("pages/connected.html"),
		missingCode: failedPage,
		oauthError: failedPage,
		invalidState: failedPage,
		serverError: failedPage,
	},
	async onAuthorize({ user, tokens }: { user: any; tokens: any }) {
		const scopes = String(tokens.scope ?? "")
			.split(/\s+/)
			.filter(Boolean);
		const requiredScopes = ["role_connections.write"];
		const missingScopes = requiredScopes.filter(
			(scope) => !scopes.includes(scope)
		);

		if (missingScopes.length > 0) {
			throw new Error(
				`Missing required OAuth scopes: ${missingScopes.join(", ")}`
			);
		}

		if (!scopes.includes("connections")) {
			console.warn(
				"[discord-oauth-callback] connections scope missing; GitHub link may not be available."
			);
		}

		await database.set(user.id, {
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			expiresAt: tokens.expires_at,
			scope: tokens.scope,
		});

		await updateDiscordMetadata(user.id, tokens.access_token);
	},
});
