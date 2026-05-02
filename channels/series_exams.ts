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
	compile: (_prev, curr, _config, items) => {
		console.log(curr.length);
		for (const item of items) {
			switch (item) {
				case "results":
					break;
				default:
					console.warn(`warning: unhandled item '${item}' in channel 'series_exams'`);
					// no use
					break;
			}
		}
		const notifications: Notification<undefined>[] = [];
		return notifications;
	},
	digest: (notifications) => {
		return notifications;
	},
});
