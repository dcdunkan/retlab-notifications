import { ApiEndPoints } from "../generated/api-endpoints.ts";
import { result } from "../generated/models.d.ts";
import { Notification } from "../types.d.ts";
import { defineChannelHandler } from "../utilities.ts";

// todo: incomplete & unused rn
export default defineChannelHandler("series_exams", {
	fetch: async (request, config) => {
		async function fetchResults() {
			const maxSessions = config["max-sessions"];
			const promises: Promise<{ session: number; results: result.ResultSeasonal[] }>[] = [];
			for (let i = 1; i <= maxSessions; i++) {
				promises.push(
					request<result.ResultSeasonal[]>(ApiEndPoints.RESULT_SEASONAL_URL, {
						body: {
							sem_id: "",
							session: `${i}`,
						} satisfies result.SeasonRequest,
					}).then((r) => ({ session: i, results: r.data })),
				);
			}
			return await Promise.all(promises);
		}
		return await fetchResults();
	},
	compile: (prev, curr, _config, items) => {
		const notifications: Notification<{ type: "series-result" }>[] = [];
		if (!items.includes("results")) return notifications;

		for (const { session, results } of curr) {
			const seen = new Set(prev.find((p) => p.session === session)?.results.map((r) => r.subject));
			for (const r of results) {
				if (seen.has(r.subject)) continue;
				notifications.push({
					title: `Series exam ${session} result published: ${r.subject}`,
					body: `You scored ${r.obtained_mark} / ${r.max_mark}.`,
					data: { type: "series-result" },
				});
			}
		}
		return notifications;
	},
	digest: (notifications) => {
		if (notifications.length <= 2) return notifications;
		return [{
			title: `${notifications.length} new series exam results`,
			body: "",
			data: { type: "series-result" as const },
		}];
	},
});
