const DEFAULT_TARGETS = ["minesa-org", "Neodevils"];
const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

function normalizeLogin(login: string) {
	return login.trim().toLowerCase();
}

type SponsorsResponse = {
	data?: {
		user?: SponsorsNode;
		organization?: SponsorsNode;
	};
	errors?: Array<{ message: string }>;
};

type SponsorsNode = {
	sponsorshipsAsMaintainer: {
		pageInfo: {
			hasNextPage: boolean;
			endCursor: string | null;
		};
		nodes: Array<{
			sponsorEntity: {
				login: string;
			} | null;
		}>;
	};
} | null;

type DiscordConnection = {
	type?: string;
	name?: string;
	verified?: boolean;
};

function getSponsorTargets(): string[] {
	const raw = process.env.GITHUB_SPONSOR_TARGETS?.trim();
	if (!raw) return DEFAULT_TARGETS;

	return raw
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

function getGitHubToken(): string {
	const token = process.env.GITHUB_TOKEN?.trim();
	if (!token) {
		throw new Error("GITHUB_TOKEN is not configured.");
	}

	return token;
}

async function fetchSponsorPage(targetLogin: string, cursor?: string | null) {
	const query = `
		query SponsorsByMaintainer($login: String!, $cursor: String) {
			user(login: $login) {
				sponsorshipsAsMaintainer(
					activeOnly: true
					includePrivate: true
					first: 100
					after: $cursor
				) {
					pageInfo {
						hasNextPage
						endCursor
					}
					nodes {
						sponsorEntity {
							... on User {
								login
							}
							... on Organization {
								login
							}
						}
					}
				}
			}
			organization(login: $login) {
				sponsorshipsAsMaintainer(
					activeOnly: true
					includePrivate: true
					first: 100
					after: $cursor
				) {
					pageInfo {
						hasNextPage
						endCursor
					}
					nodes {
						sponsorEntity {
							... on User {
								login
							}
							... on Organization {
								login
							}
						}
					}
				}
			}
		}
	`;

	const response = await fetch(GITHUB_GRAPHQL_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${getGitHubToken()}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			query,
			variables: { login: targetLogin, cursor: cursor ?? null },
		}),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(
			`GitHub GraphQL request failed (${response.status}): ${text}`
		);
	}

	const payload = (await response.json()) as SponsorsResponse;
	if (payload.errors?.length) {
		throw new Error(
			`GitHub GraphQL errors: ${payload.errors
				.map((error) => error.message)
				.join(", ")}`
		);
	}

	const source =
		payload.data?.user?.sponsorshipsAsMaintainer ??
		payload.data?.organization?.sponsorshipsAsMaintainer;

	if (!source) {
		return {
			hasNextPage: false,
			endCursor: null as string | null,
			sponsors: [] as string[],
		};
	}

	return {
		hasNextPage: source.pageInfo.hasNextPage,
		endCursor: source.pageInfo.endCursor,
		sponsors: source.nodes
			.map((node) => node.sponsorEntity?.login?.toLowerCase())
			.filter((login): login is string => Boolean(login)),
	};
}

async function isUserSponsoringTarget(
	githubUsername: string,
	targetLogin: string
): Promise<boolean> {
	const normalizedUsername = githubUsername.toLowerCase();
	let cursor: string | null = null;
	let pageCount = 0;

	while (pageCount < 20) {
		const page = await fetchSponsorPage(targetLogin, cursor);
		if (page.sponsors.includes(normalizedUsername)) {
			return true;
		}

		if (!page.hasNextPage || !page.endCursor) {
			return false;
		}

		cursor = page.endCursor;
		pageCount += 1;
	}

	return false;
}

export async function getDiscordGithubUsername(accessToken: string) {
	const response = await fetch("https://discord.com/api/v10/users/@me/connections", {
		headers: {
			Authorization: `Bearer ${accessToken}`,
		},
	});

	if (!response.ok) {
		const text = await response.text();
		console.error(
			`[githubSponsors] Discord connections fetch failed (${response.status}): ${text}`
		);
		return null;
	}

	const connections = (await response.json()) as DiscordConnection[];
	const githubConnection = connections.find(
		(connection) =>
			connection.type === "github" &&
			typeof connection.name === "string" &&
			connection.name.length > 0
	);

	return githubConnection?.name ?? null;
}

export async function getSponsorMatch(githubUsername: string) {
	if (!process.env.GITHUB_TOKEN?.trim()) {
		console.warn(
			"[githubSponsors] GITHUB_TOKEN is not set; sponsor check skipped (is_sponsor will be false)."
		);
		return { isSponsor: false, matchedTarget: null as string | null };
	}

	const targets = getSponsorTargets();

	for (const target of targets) {
		const isSponsor = await isUserSponsoringTarget(githubUsername, target);
		if (isSponsor) {
			return { isSponsor: true, matchedTarget: target };
		}
	}

	return { isSponsor: false, matchedTarget: null as string | null };
}

async function isUserContributorOfPrivateRepo(
	githubUsername: string
): Promise<boolean> {
	const token = process.env.GITHUB_TOKEN?.trim();
	if (!token) {
		console.warn(
			"[githubSponsors] GITHUB_TOKEN is not set; contributor check skipped (Contributor will be false)."
		);
		return false;
	}

	const owner =
		process.env.GITHUB_CONTRIBUTOR_REPO_OWNER?.trim() ?? "minesa-org";
	const repo =
		process.env.GITHUB_CONTRIBUTOR_REPO_NAME?.trim() ??
		"dungeon-blitz-typescript";

	const normalizedUsername = normalizeLogin(githubUsername);

	const perPage = 100;
	let page = 1;

	// contributors list can be paginated; keep going until we find a match or no next page.
	while (page <= 10) {
		const url = `https://api.github.com/repos/${owner}/${repo}/contributors?per_page=${perPage}&anon=0&page=${page}`;

		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
		});

		if (!response.ok) {
			const text = await response.text();
			console.error(
				`[githubSponsors] Contributor check failed (${response.status}): ${text}`
			);
			return false;
		}

		const contributors = (await response.json()) as Array<{
			login?: string;
		}>;

		if (!Array.isArray(contributors) || contributors.length === 0) {
			return false;
		}

		if (
			contributors.some((c) => c.login && normalizeLogin(c.login) === normalizedUsername)
		) {
			return true;
		}

		const link = response.headers.get("link") ?? "";
		if (!link.includes('rel="next"')) {
			return false;
		}

		page += 1;
	}

	return false;
}

export async function getContributorMatch(githubUsername: string) {
	const isContributor = await isUserContributorOfPrivateRepo(githubUsername);
	return { isContributor };
}
