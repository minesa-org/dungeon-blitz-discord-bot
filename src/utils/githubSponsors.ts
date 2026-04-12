import { MiniDatabase } from "@minesa-org/mini-interaction";

const DEFAULT_TARGETS = ["minesa-org", "Neodevils"];
const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const DEFAULT_SPONSOR_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_SPONSOR_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeLogin(login: string) {
	return login.trim().toLowerCase();
}

type SponsorsResponse = {
	data?: {
		viewer?: {
			login: string;
		};
		repositoryOwner?: SponsorsOwner;
	};
	errors?: Array<{ message: string }>;
};

type SponsorsOwner = {
	__typename?: "User" | "Organization" | string;
	userSponsorships?: SponsorsNode;
	organizationSponsorships?: SponsorsNode;
} | null;

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

type SponsorDirectory = {
	sponsors: Set<string>;
	viewerLogin: string | null;
};

type SponsorDirectoryCacheEntry = {
	value: SponsorDirectory;
	expiresAt: number;
};

type PersistedSponsorDirectory = {
	targetLogin: string;
	includePrivate: boolean;
	viewerLogin: string | null;
	sponsors: string[];
	fetchedAt: number;
};

export type StoredSponsorSnapshot = {
	targetLogin: string;
	includePrivate: boolean;
	viewerLogin: string | null;
	sponsors: string[];
	fetchedAt: number;
	isFresh: boolean;
};

class GitHubRateLimitError extends Error {
	retryAt: number;

	constructor(message: string, retryAt: number) {
		super(message);
		this.name = "GitHubRateLimitError";
		this.retryAt = retryAt;
	}
}

const sponsorDirectoryCache = new Map<string, SponsorDirectoryCacheEntry>();
const sponsorDirectoryInflight = new Map<string, Promise<SponsorDirectory>>();
const sponsorResultCache = new Map<
	string,
	{
		value: { isSponsor: boolean; matchedTarget: string | null };
		expiresAt: number;
	}
>();

let sponsorRateLimitCooldownUntil = 0;
let sponsorSnapshotDb: MiniDatabase | null | undefined;

function getSponsorTargets(): string[] {
	const raw = process.env.GITHUB_SPONSOR_TARGETS?.trim();
	if (!raw) return DEFAULT_TARGETS;

	return raw
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

function shouldForcePublicSponsors() {
	return process.env.GITHUB_SPONSOR_FORCE_PUBLIC?.trim().toLowerCase() === "true";
}

function getGitHubToken() {
	if (shouldForcePublicSponsors()) {
		return null;
	}

	return process.env.GITHUB_TOKEN?.trim() || null;
}

function isSponsorDebugEnabled() {
	return process.env.GITHUB_SPONSOR_DEBUG?.trim().toLowerCase() === "true";
}

function getSponsorCacheTtlMs() {
	const raw = Number(process.env.GITHUB_SPONSOR_CACHE_TTL_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SPONSOR_CACHE_TTL_MS;
}

function getSponsorRateLimitCooldownMs() {
	const raw = Number(process.env.GITHUB_SPONSOR_RATE_LIMIT_COOLDOWN_MS);
	return Number.isFinite(raw) && raw > 0
		? raw
		: DEFAULT_RATE_LIMIT_COOLDOWN_MS;
}

function getSponsorRefreshIntervalMs() {
	const raw = Number(process.env.GITHUB_SPONSOR_REFRESH_INTERVAL_MS);
	return Number.isFinite(raw) && raw > 0
		? raw
		: DEFAULT_SPONSOR_REFRESH_INTERVAL_MS;
}

function getSponsorDirectoryCacheKey(targetLogin: string, includePrivate: boolean) {
	return `${normalizeLogin(targetLogin)}|${includePrivate ? "private" : "public"}`;
}

function getSponsorResultCacheKey(
	githubUsername: string,
	targets: string[],
	tokenMode: string
) {
	return `${normalizeLogin(githubUsername)}|${tokenMode}|${targets
		.map(normalizeLogin)
		.join(",")}`;
}

function getCachedResult<T extends { expiresAt: number; value: unknown }>(
	cache: Map<string, T>,
	key: string
) {
	const entry = cache.get(key);
	if (!entry) return null;
	if (entry.expiresAt <= Date.now()) {
		cache.delete(key);
		return null;
	}

	return entry.value as T["value"];
}

function setCachedResult<T>(
	cache: Map<
		string,
		{
			value: T;
			expiresAt: number;
		}
	>,
	key: string,
	value: T,
	ttlMs: number
) {
	cache.set(key, {
		value,
		expiresAt: Date.now() + ttlMs,
	});
}

function noteRateLimitCooldown(retryAt: number, context: string) {
	sponsorRateLimitCooldownUntil = Math.max(sponsorRateLimitCooldownUntil, retryAt);
	console.warn(
		`[githubSponsors] Rate limit cooldown active until ${new Date(sponsorRateLimitCooldownUntil).toISOString()} (${context}).`
	);
}

function getSponsorSnapshotDb() {
	if (sponsorSnapshotDb !== undefined) {
		return sponsorSnapshotDb;
	}

	try {
		sponsorSnapshotDb = MiniDatabase.fromEnv();
		return sponsorSnapshotDb;
	} catch (error) {
		console.warn(
			`[githubSponsors] Sponsor snapshot DB unavailable: ${
				error instanceof Error ? error.message : String(error)
			}`
		);
		sponsorSnapshotDb = null;
		return sponsorSnapshotDb;
	}
}

function getSponsorSnapshotKey(targetLogin: string, includePrivate: boolean) {
	return `system:github-sponsors:${getSponsorDirectoryCacheKey(
		targetLogin,
		includePrivate
	)}`;
}

function toPersistedSponsorDirectory(
	targetLogin: string,
	includePrivate: boolean,
	directory: SponsorDirectory
): PersistedSponsorDirectory {
	return {
		targetLogin: normalizeLogin(targetLogin),
		includePrivate,
		viewerLogin: directory.viewerLogin,
		sponsors: Array.from(directory.sponsors),
		fetchedAt: Date.now(),
	};
}

function fromPersistedSponsorDirectory(
	value: unknown
): PersistedSponsorDirectory | null {
	if (!value || typeof value !== "object") return null;

	const record = value as Record<string, unknown>;
	const sponsors = Array.isArray(record.sponsors)
		? record.sponsors.filter((entry): entry is string => typeof entry === "string")
		: null;
	const fetchedAt =
		typeof record.fetchedAt === "number" ? record.fetchedAt : Number(record.fetchedAt);

	if (
		typeof record.targetLogin !== "string" ||
		typeof record.includePrivate !== "boolean" ||
		!sponsors ||
		!Number.isFinite(fetchedAt)
	) {
		return null;
	}

	return {
		targetLogin: normalizeLogin(record.targetLogin),
		includePrivate: record.includePrivate,
		viewerLogin:
			typeof record.viewerLogin === "string" ? record.viewerLogin : null,
		sponsors: sponsors.map(normalizeLogin),
		fetchedAt,
	};
}

function isSponsorSnapshotFresh(snapshot: PersistedSponsorDirectory) {
	return Date.now() - snapshot.fetchedAt < getSponsorRefreshIntervalMs();
}

async function loadPersistedSponsorDirectory(
	targetLogin: string,
	includePrivate: boolean
) {
	const snapshotDb = getSponsorSnapshotDb();
	if (!snapshotDb) return null;

	const key = getSponsorSnapshotKey(targetLogin, includePrivate);
	const persisted = fromPersistedSponsorDirectory(await snapshotDb.get(key));
	if (!persisted) {
		return null;
	}

	if (isSponsorDebugEnabled()) {
		console.info(
			`[githubSponsors] Loaded sponsor snapshot for "${targetLogin}" (includePrivate=${includePrivate}, fetchedAt=${new Date(persisted.fetchedAt).toISOString()}, sponsorCount=${persisted.sponsors.length}).`
		);
	}

	return persisted;
}

export async function getStoredSponsorSnapshots(): Promise<StoredSponsorSnapshot[]> {
	const targets = getSponsorTargets();
	const snapshots: StoredSponsorSnapshot[] = [];

	for (const targetLogin of targets) {
		for (const includePrivate of [true, false]) {
			const persisted = await loadPersistedSponsorDirectory(
				targetLogin,
				includePrivate
			);
			if (!persisted) {
				continue;
			}

			snapshots.push({
				targetLogin: persisted.targetLogin,
				includePrivate: persisted.includePrivate,
				viewerLogin: persisted.viewerLogin,
				sponsors: persisted.sponsors,
				fetchedAt: persisted.fetchedAt,
				isFresh: isSponsorSnapshotFresh(persisted),
			});
		}
	}

	return snapshots.sort((a, b) => b.fetchedAt - a.fetchedAt);
}

async function savePersistedSponsorDirectory(
	targetLogin: string,
	includePrivate: boolean,
	directory: SponsorDirectory
) {
	const snapshotDb = getSponsorSnapshotDb();
	if (!snapshotDb) return;

	const key = getSponsorSnapshotKey(targetLogin, includePrivate);
	const persisted = toPersistedSponsorDirectory(
		targetLogin,
		includePrivate,
		directory
	);
	const saved = await snapshotDb.set(key, persisted);
	if (!saved) {
		console.warn(
			`[githubSponsors] Failed to persist sponsor snapshot for "${targetLogin}" (includePrivate=${includePrivate}).`
		);
	}
}

function assertRateLimitCooldownInactive() {
	if (sponsorRateLimitCooldownUntil > Date.now()) {
		throw new GitHubRateLimitError(
			`GitHub sponsor checks are cooling down until ${new Date(sponsorRateLimitCooldownUntil).toISOString()}.`,
			sponsorRateLimitCooldownUntil
		);
	}
}

function formatSponsorLogins(logins: string[], limit = 20) {
	if (logins.length === 0) return "(none)";
	if (logins.length <= limit) return logins.join(", ");

	return `${logins.slice(0, limit).join(", ")} ... (+${logins.length - limit} more)`;
}

function logSponsorPageResult(input: {
	targetLogin: string;
	pageNumber: number;
	includePrivate: boolean;
	viewerLogin: string | null;
	sponsors: string[];
	hasNextPage: boolean;
}) {
	if (!isSponsorDebugEnabled()) {
		return;
	}

	const { targetLogin, pageNumber, includePrivate, viewerLogin, sponsors, hasNextPage } =
		input;
	console.info(
		`[githubSponsors] Sponsors page ${pageNumber} for "${targetLogin}" (viewer=${viewerLogin ?? "unknown"}, includePrivate=${includePrivate}, count=${sponsors.length}, hasNextPage=${hasNextPage}): ${formatSponsorLogins(sponsors)}`
	);
}

function logStoredSponsorDirectory(
	targetLogin: string,
	includePrivate: boolean,
	directory: SponsorDirectory
) {
	console.info(
		`[githubSponsors] Stored sponsor list for "${targetLogin}" (includePrivate=${includePrivate}, count=${directory.sponsors.size}): ${formatSponsorLogins(Array.from(directory.sponsors))}`
	);
}

async function fetchSponsorPage(
	targetLogin: string,
	options?: {
		cursor?: string | null;
		includePrivate?: boolean;
	}
) {
	assertRateLimitCooldownInactive();

	const token = getGitHubToken();
	const includePrivate = options?.includePrivate ?? Boolean(token);
	const query = `
		query SponsorsByMaintainer(
			$login: String!
			$cursor: String
			$includePrivate: Boolean!
		) {
			viewer {
				login
			}
			repositoryOwner(login: $login) {
				__typename
				... on User {
					userSponsorships: sponsorshipsAsMaintainer(
						activeOnly: true
						includePrivate: $includePrivate
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
				... on Organization {
					organizationSponsorships: sponsorshipsAsMaintainer(
						activeOnly: true
						includePrivate: $includePrivate
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
		}
	`;

	const response = await fetch(GITHUB_GRAPHQL_URL, {
		method: "POST",
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			query,
			variables: {
				login: targetLogin,
				cursor: options?.cursor ?? null,
				includePrivate,
			},
		}),
	});

	if (!response.ok) {
		const text = await response.text();
		if (response.status === 403 && text.toLowerCase().includes("rate limit")) {
			const retryAfterHeader = response.headers.get("retry-after");
			const resetHeader = response.headers.get("x-ratelimit-reset");
			const retryAfterMs = retryAfterHeader
				? Number(retryAfterHeader) * 1000
				: null;
			const resetAtMs = resetHeader ? Number(resetHeader) * 1000 : null;
			const retryAt = Math.max(
				Date.now() + getSponsorRateLimitCooldownMs(),
				retryAfterMs ? Date.now() + retryAfterMs : 0,
				resetAtMs ?? 0
			);
			throw new GitHubRateLimitError(
				`GitHub GraphQL request failed (${response.status}): ${text}`,
				retryAt
			);
		}
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

	const owner = payload.data?.repositoryOwner;
	const source = owner?.userSponsorships?.sponsorshipsAsMaintainer
		? owner.userSponsorships.sponsorshipsAsMaintainer
		: owner?.organizationSponsorships?.sponsorshipsAsMaintainer;

	if (!source) {
		if (isSponsorDebugEnabled()) {
			console.info(
				`[githubSponsors] Sponsor query returned no sponsorshipsAsMaintainer for "${targetLogin}" (owner type: ${owner?.__typename ?? "unknown"}).`
			);
		}
		return {
			hasNextPage: false,
			endCursor: null as string | null,
			viewerLogin: payload.data?.viewer?.login ?? null,
			sponsors: [] as string[],
		};
	}

	return {
		hasNextPage: source.pageInfo.hasNextPage,
		endCursor: source.pageInfo.endCursor,
		viewerLogin: payload.data?.viewer?.login ?? null,
		sponsors: source.nodes
			.map((node) => node.sponsorEntity?.login?.toLowerCase())
			.filter((login): login is string => Boolean(login)),
	};
}

async function getSponsorDirectory(
	targetLogin: string
): Promise<SponsorDirectory> {
	const token = getGitHubToken();
	const includePrivate = Boolean(token);
	const cacheKey = getSponsorDirectoryCacheKey(targetLogin, includePrivate);
	const cached = getCachedResult(sponsorDirectoryCache, cacheKey);
	if (cached) {
		if (isSponsorDebugEnabled()) {
			console.info(
				`[githubSponsors] Sponsor directory cache hit for "${targetLogin}" (includePrivate=${includePrivate}).`
			);
		}
		return cached;
	}

	const inflight = sponsorDirectoryInflight.get(cacheKey);
	if (inflight) {
		if (isSponsorDebugEnabled()) {
			console.info(
				`[githubSponsors] Waiting for in-flight sponsor directory fetch for "${targetLogin}" (includePrivate=${includePrivate}).`
			);
		}
		return inflight;
	}

	const persisted = await loadPersistedSponsorDirectory(targetLogin, includePrivate);
	if (persisted && isSponsorSnapshotFresh(persisted)) {
		const directory = {
			sponsors: new Set(persisted.sponsors),
			viewerLogin: persisted.viewerLogin,
		};
		setCachedResult(
			sponsorDirectoryCache,
			cacheKey,
			directory,
			getSponsorCacheTtlMs()
		);
		if (isSponsorDebugEnabled()) {
			console.info(
				`[githubSponsors] Using fresh weekly sponsor snapshot for "${targetLogin}" (includePrivate=${includePrivate}).`
			);
		}
		return directory;
	}

	const promise = (async () => {
		assertRateLimitCooldownInactive();
		const sponsors = new Set<string>();
		let viewerLogin: string | null = null;
		let cursor: string | null = null;
		let pageNumber = 1;

		while (pageNumber <= 20) {
			const page = await fetchSponsorPage(targetLogin, {
				cursor,
				includePrivate,
			});
			viewerLogin = page.viewerLogin;
			logSponsorPageResult({
				targetLogin,
				pageNumber,
				includePrivate,
				viewerLogin: page.viewerLogin,
				sponsors: page.sponsors,
				hasNextPage: page.hasNextPage,
			});

			if (pageNumber === 1 && page.sponsors.length === 0 && token) {
				const publicPage = await fetchSponsorPage(targetLogin, {
					includePrivate: false,
				});
				logSponsorPageResult({
					targetLogin,
					pageNumber: 1,
					includePrivate: false,
					viewerLogin: publicPage.viewerLogin,
					sponsors: publicPage.sponsors,
					hasNextPage: publicPage.hasNextPage,
				});
			}

			for (const sponsor of page.sponsors) {
				sponsors.add(sponsor);
			}

			if (!page.hasNextPage || !page.endCursor) {
				const directory = { sponsors, viewerLogin };
				await savePersistedSponsorDirectory(
					targetLogin,
					includePrivate,
					directory
				);
				setCachedResult(
					sponsorDirectoryCache,
					cacheKey,
					directory,
					getSponsorCacheTtlMs()
				);
				return directory;
			}

			cursor = page.endCursor;
			pageNumber += 1;
		}

		console.warn(
			`[githubSponsors] Pagination limit reached while fetching sponsor directory for "${targetLogin}".`
		);
		const directory = { sponsors, viewerLogin };
		await savePersistedSponsorDirectory(targetLogin, includePrivate, directory);
		setCachedResult(
			sponsorDirectoryCache,
			cacheKey,
			directory,
			getSponsorCacheTtlMs()
		);
		return directory;
	})()
		.catch((error) => {
			if (error instanceof GitHubRateLimitError) {
				noteRateLimitCooldown(error.retryAt, `target="${targetLogin}"`);
			}
			if (persisted) {
				console.warn(
					`[githubSponsors] Falling back to stale sponsor snapshot for "${targetLogin}" fetched at ${new Date(persisted.fetchedAt).toISOString()}.`
				);
				const staleDirectory = {
					sponsors: new Set(persisted.sponsors),
					viewerLogin: persisted.viewerLogin,
				};
				setCachedResult(
					sponsorDirectoryCache,
					cacheKey,
					staleDirectory,
					getSponsorCacheTtlMs()
				);
				return staleDirectory;
			}
			throw error;
		})
		.finally(() => {
			sponsorDirectoryInflight.delete(cacheKey);
		});

	sponsorDirectoryInflight.set(cacheKey, promise);
	return promise;
}

async function isUserSponsoringTarget(
	githubUsername: string,
	targetLogin: string
): Promise<boolean> {
	const normalizedUsername = githubUsername.toLowerCase();
	const includePrivate = Boolean(getGitHubToken());
	const directory = await getSponsorDirectory(targetLogin);
	logStoredSponsorDirectory(targetLogin, includePrivate, directory);
	const isSponsor = directory.sponsors.has(normalizedUsername);

	if (isSponsor) {
		console.info(
			`[githubSponsors] Matched sponsor "${normalizedUsername}" for target "${targetLogin}".`
		);
		return true;
	}

	console.info(
		`[githubSponsors] No sponsor match for "${normalizedUsername}" on target "${targetLogin}".`
	);
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
	const token = getGitHubToken();
	if (!token) {
		console.warn(
			shouldForcePublicSponsors()
				? "[githubSponsors] GITHUB_SPONSOR_FORCE_PUBLIC=true; checking public sponsorships only."
				: "[githubSponsors] GITHUB_TOKEN is not set; checking public sponsorships only."
		);
	}

	if (isSponsorDebugEnabled()) {
		console.info(
			`[githubSponsors] Sponsor check mode: ${token ? "token-authenticated" : "public-only"}.`
		);
	}

	const targets = getSponsorTargets();
	const resultCacheKey = getSponsorResultCacheKey(
		githubUsername,
		targets,
		token ? "token" : "public"
	);
	const cached = getCachedResult(sponsorResultCache, resultCacheKey);
	if (cached) {
		if (isSponsorDebugEnabled()) {
			console.info(
				`[githubSponsors] Sponsor result cache hit for "${normalizeLogin(githubUsername)}".`
			);
		}
		return cached;
	}

	console.info(
		`[githubSponsors] Checking sponsor status for "${normalizeLogin(githubUsername)}" against targets: ${targets.join(", ")}`
	);

	for (const target of targets) {
		try {
			const isSponsor = await isUserSponsoringTarget(githubUsername, target);
			if (isSponsor) {
				const result = { isSponsor: true, matchedTarget: target };
				setCachedResult(
					sponsorResultCache,
					resultCacheKey,
					result,
					getSponsorCacheTtlMs()
				);
				return result;
			}
		} catch (error) {
			if (error instanceof GitHubRateLimitError) {
				console.warn(
					`[githubSponsors] Sponsor check paused by rate limit: ${error.message}`
				);
				break;
			}
			console.warn(
				`[githubSponsors] Sponsor check failed for target "${target}": ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	const result = { isSponsor: false, matchedTarget: null as string | null };
	setCachedResult(
		sponsorResultCache,
		resultCacheKey,
		result,
		getSponsorCacheTtlMs()
	);
	return result;
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
			contributors.some(
				(c) => c.login && normalizeLogin(c.login) === normalizedUsername
			)
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
