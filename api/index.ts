import { mini } from "./interactions.js";

export default mini.discordOAuthVerificationPage({
	htmlFile: "public/pages/verify.html",
	scopes: ["identify", "connections", "role_connections.write"],
});
