import { TZ_FORMATTER } from "../constants.ts";
import { ApiEndPoints } from "../generated/api-endpoints.ts";
import { survey } from "../generated/models.d.ts";
import { Notification } from "../types.d.ts";
import { defineChannelHandler, isValidDate, parseServerDateString, pluralize } from "../utilities.ts";

type SurveyType = "teacher_evaluation" | "general" | "course_exit";

const KNOWN_SURVEY_TYPES: Record<string, SurveyType> = {
	"1": "teacher_evaluation",
	"2": "general",
	// todo: my guesses are, 3=po, 4=graduateexit
	"5": "course_exit",
	// all else is general
};
const SURVEY_TYPE_DISPLAY_NAME: Record<SurveyType, string> = {
	course_exit: "Course exit",
	general: "General",
	teacher_evaluation: "Teacher evaluation",
};

export default defineChannelHandler("surveys", {
	fetch: async (request) => {
		const surveys = await request<survey.Survey[]>(ApiEndPoints.SURVEY_URL);
		return surveys.data;
	},
	compile: (prev, curr, _, items) => {
		const currFiltered = curr.filter((survey) => items.includes(KNOWN_SURVEY_TYPES[survey.type] ?? "general"));
		if (currFiltered.length === 0) return [];

		const prevFiltered = prev.filter((survey) => items.includes(KNOWN_SURVEY_TYPES[survey.type] ?? "general"));

		const newOnes = currFiltered
			// filter the newly added ones:
			.filter((c) =>
				prevFiltered.findIndex((p) => {
					return p.survey_id === c.survey_id ||
						// @ts-expect-error session_id is there!!
						p.session_id === c.session_id;
				}) < 0
			)
			// filter only incomplete ones && there is still time till last date:
			.filter((c) => !c.complete && c.btn_status !== "Last Date Over");

		const notifications: (Notification<{ type: "new-survey" }>)[] = [];

		for (const survey of newOnes) {
			const surveyType = KNOWN_SURVEY_TYPES[survey.type] ?? "general";
			const parsedLastDate = parseServerDateString(survey.last_date);
			if (isValidDate(parsedLastDate)) {
				notifications.push({
					data: { type: "new-survey" },
					title: `New ${SURVEY_TYPE_DISPLAY_NAME[surveyType]} survey`,
					body: `${survey.name} survey under session ${survey.session}. Complete the survey before ${
						TZ_FORMATTER.format(parsedLastDate)
					}`,
				});
			} else {
				notifications.push({
					data: { type: "new-survey" },
					title: `New ${SURVEY_TYPE_DISPLAY_NAME[surveyType]} survey`,
					body:
						`${survey.name} survey under session ${survey.session}. Last date is unknown, check the official application.`,
				});
			}
		}

		return notifications;
	},
	digest: (notifications) => {
		const digested: Notification<{ type: "new-surveys" }>[] = [];

		const newOnes = notifications.filter((n) => n.data.type === "new-survey");
		if (newOnes.length > 0) {
			digested.push({
				title: pluralize(
					newOnes.length,
					"You have a new survey to complete",
					`You have ${newOnes.length} new surveys to complete`,
				),
				body: "",
				data: { type: "new-surveys" },
			});
		}

		return digested;
	},
});
