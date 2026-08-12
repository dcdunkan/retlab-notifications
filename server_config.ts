import z from "@zod/zod";
import { SERVER_VERSION } from "./constants.ts";
import type { ServerConfiguration, ServerConfigValidators } from "./types.d.ts";
import { env } from "./env.ts";

export const ServerConfig = {
	version: SERVER_VERSION,
	contact: env.CONTACT_URL,
	channels: {
		assignments: {
			name: "Assignments",
			description: "",
			items: {
				new_assignments: {
					name: "New assignments",
					active: false,
					description: "when new assignments are posted",
				},
				last_date_nearing: {
					name: "Last date reminders",
					active: false,
					description: "reminders as an assignment's submission deadline approaches",
				},
				results: {
					active: false,
					name: "Assignment results",
					description: "when an assignment has been evaluated and result is published",
				},
			},
		},
		attendance: {
			name: "Attendance",
			description: "",
			items: {
				new_attendance_marked: {
					name: "New attendance marked",
					active: true,
					description: "when new subject attendance is marked",
				},
			},
		},
		series_exams: {
			name: "Series Exams",
			description: "",
			items: {
				results: {
					active: false,
					name: "Series exam results",
					description: "when series examination results are published or modified (set max-sessions in config)",
				},
			},
		},
		surveys: {
			name: "Surveys",
			description: "",
			items: {
				teacher_evaluation: {
					active: true,
					name: "Teacher evaluation surveys",
					description: "when new teacher evaluation surveys are posted",
				},
				course_exit: {
					active: true,
					name: "Course exit surveys",
					description: "when new course exit surveys are posted",
				},
				general: {
					active: true,
					name: "General surveys",
					description: "when new general surveys are posted",
				},
			},
		},
	},
	config: {
		"min-update-interval": {
			name: "Minimum update interval",
			description: "Minimum time before checking for notifications in minutes",
			type: "integer",
			defaultValue: 5,
			min: 5,
			max: 60 * 24 * 7, // 7 days in minutes
		},
		"max-sessions": {
			name: "Maximum number of series exams",
			description: "Maximum number of series exams to check (please keep it to a practical minimum)",
			type: "integer",
			defaultValue: 2,
			min: 1,
			max: 8, // maximum 8 series exam as per etlab
		},
		"only-when-absent": {
			name: "Notify only on absent is marked",
			description:
				"If enabled, when new attendance is marked, notifications will only be sent if you were marked as absent.",
			type: "boolean",
			defaultValue: true,
		},
		"min-attendance-threshold-percent": {
			name: "Minimum attendance percentage cutoff",
			description:
				"Minimum attendance percentage considered as safe range. Above or equal to this value will be considered as safe. If set to more than the maximum cutoff, then it will be capped by it.",
			type: "integer",
			defaultValue: 75,
			min: 1,
			max: 99,
		},
		"max-attendance-threshold-percent": {
			name: "Maximum attendance percentage cutoff",
			description: "The highest percentage considered as safe. Anything above it is considered as excellent.",
			type: "integer",
			defaultValue: 90,
			min: 1,
			max: 99,
		},
	},
} satisfies ServerConfiguration;

export const Validators: ServerConfigValidators<typeof ServerConfig> = {
	"max-sessions": z.int()
		.min(ServerConfig.config["max-sessions"].min)
		.max(ServerConfig.config["max-sessions"].max),
	"only-when-absent": z.boolean(),
	"min-update-interval": z.int()
		.min(ServerConfig.config["min-update-interval"].min)
		.max(ServerConfig.config["min-update-interval"].max),
	"min-attendance-threshold-percent": z.int()
		.min(ServerConfig.config["min-attendance-threshold-percent"].min)
		.max(ServerConfig.config["min-attendance-threshold-percent"].max),
	"max-attendance-threshold-percent": z.int()
		.min(ServerConfig.config["max-attendance-threshold-percent"].min)
		.max(ServerConfig.config["max-attendance-threshold-percent"].max),
};
34;
