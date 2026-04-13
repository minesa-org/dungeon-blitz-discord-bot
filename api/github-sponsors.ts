import {
	getStoredSponsorSnapshots,
	type StoredSponsorSnapshot,
} from "../src/utils/githubSponsors.js";

type SponsorItem = {
	login: string;
	name: string;
	url: string;
	targets: string[];
	includePrivate: boolean;
};

function pickPreferredSnapshots(snapshots: StoredSponsorSnapshot[]) {
	const preferred = new Map<string, StoredSponsorSnapshot>();

	for (const snapshot of snapshots) {
		const current = preferred.get(snapshot.targetLogin);
		if (!current) {
			preferred.set(snapshot.targetLogin, snapshot);
			continue;
		}

		if (snapshot.includePrivate && !current.includePrivate) {
			preferred.set(snapshot.targetLogin, snapshot);
			continue;
		}

		if (snapshot.fetchedAt > current.fetchedAt) {
			preferred.set(snapshot.targetLogin, snapshot);
		}
	}

	return Array.from(preferred.values());
}

function buildItems(snapshots: StoredSponsorSnapshot[]): SponsorItem[] {
	return buildItemsFromSnapshots(snapshots, "sponsors");
}

function buildPastItems(snapshots: StoredSponsorSnapshot[]): SponsorItem[] {
	return buildItemsFromSnapshots(snapshots, "pastSponsors");
}

function buildItemsFromSnapshots(
	snapshots: StoredSponsorSnapshot[],
	field: "sponsors" | "pastSponsors"
) {
	const sponsors = new Map<string, SponsorItem>();

	for (const snapshot of snapshots) {
		for (const login of snapshot[field]) {
			const normalized = login.trim().toLowerCase();
			const existing = sponsors.get(normalized);
			if (existing) {
				if (!existing.targets.includes(snapshot.targetLogin)) {
					existing.targets.push(snapshot.targetLogin);
				}
				existing.includePrivate = existing.includePrivate || snapshot.includePrivate;
				continue;
			}

			sponsors.set(normalized, {
				login: normalized,
				name: normalized,
				url: `https://github.com/${normalized}`,
				targets: [snapshot.targetLogin],
				includePrivate: snapshot.includePrivate,
			});
		}
	}

	return Array.from(sponsors.values()).sort((a, b) =>
		a.login.localeCompare(b.login)
	);
}

export default async function handler(_req: any, res: any) {
	try {
		const snapshots = await getStoredSponsorSnapshots();
		const preferredSnapshots = pickPreferredSnapshots(snapshots);
		const items = buildItems(preferredSnapshots);
		const pastItems = buildPastItems(preferredSnapshots);
		const fetchedAt = preferredSnapshots.reduce<number | null>(
			(latest, snapshot) =>
				latest === null || snapshot.fetchedAt > latest
					? snapshot.fetchedAt
					: latest,
			null
		);
		const totalCount = preferredSnapshots.reduce(
			(sum, snapshot) => sum + Math.max(snapshot.totalCount ?? snapshot.sponsors.length, 0),
			0
		);
		const publicCount = preferredSnapshots.reduce(
			(sum, snapshot) =>
				sum + Math.max(snapshot.publicCount ?? snapshot.sponsors.length, 0),
			0
		);
		const pastTotalCount = preferredSnapshots.reduce(
			(sum, snapshot) =>
				sum +
				Math.max(snapshot.pastTotalCount ?? snapshot.pastSponsors.length, 0),
			0
		);
		const pastPublicCount = preferredSnapshots.reduce(
			(sum, snapshot) =>
				sum +
				Math.max(snapshot.pastPublicCount ?? snapshot.pastSponsors.length, 0),
			0
		);

		res.setHeader("Content-Type", "application/json; charset=utf-8");
		res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=3600");
		return res.status(200).json({
			items,
			pastItems,
			totalCount,
			publicCount,
			pastTotalCount,
			pastPublicCount,
			fetchedAt,
			targets: preferredSnapshots.map((snapshot) => ({
				targetLogin: snapshot.targetLogin,
				includePrivate: snapshot.includePrivate,
				viewerLogin: snapshot.viewerLogin,
				sponsorCount: snapshot.sponsors.length,
				totalCount: snapshot.totalCount,
				publicCount: snapshot.publicCount,
				pastSponsorCount: snapshot.pastSponsors.length,
				pastTotalCount: snapshot.pastTotalCount,
				pastPublicCount: snapshot.pastPublicCount,
				fetchedAt: snapshot.fetchedAt,
				isFresh: snapshot.isFresh,
			})),
		});
	} catch (error) {
		res.setHeader("Content-Type", "application/json; charset=utf-8");
		return res.status(500).json({
			error:
				error instanceof Error
					? error.message
					: "Failed to load stored sponsor snapshots.",
		});
	}
}
