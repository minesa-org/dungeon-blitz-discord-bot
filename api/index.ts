import { mini } from "./interactions.js";
import { discordOAuthConfig } from "../src/utils/oauthConfig.js";

export default mini.discordOAuthVerificationPage({
	htmlFile: "pages/verify.html",
	oauth: discordOAuthConfig,
	scopes: ["identify", "connections", "role_connections.write"],
});
