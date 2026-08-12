import { ApiEndPoints } from "../generated/api-endpoints.ts";
import type { attendance } from "../generated/models.d.ts";
import { Notification } from "../types.d.ts";
import { cutePercent, defineChannelHandler, pluralize, safeDivision } from "../utilities.ts";

type AttendanceNotification = Notification<{
	type: "attendance-marked";
	subjects: string[];
}>;

type SubjectStats = {
	attended: number;
	classes: number;
};

type ParsedAttendanceSubject = {
	name: string;
	code: string;
	normal: SubjectStats;
	duty_leave: SubjectStats;
};

type PercentStats = {
	cuttable: number;
	needed: number;
};

export default defineChannelHandler("attendance", {
	fetch: async (request) => {
		const response = await request<attendance.AttendanceResponse>(ApiEndPoints.ATTENDANCE_BY_SUBJECT_URL, {
			method: "POST",
			body: { sem_id: "" } satisfies attendance.AttendanceRequest,
		});
		return response.data.subjects;
	},
	compile: (prev, curr, config, items) => {
		const notifications: AttendanceNotification[] = [];

		if (items.length === 0) return notifications;

		const parsedCurr = parseAttendance(curr);
		const parsedPrev = parseAttendance(prev);

		for (const currSubjectCode in parsedCurr) {
			const currSubject = parsedCurr[currSubjectCode];
			const prevSubject = parsedPrev[currSubjectCode] ?? {
				code: currSubject.code,
				duty_leave: { attended: 0, classes: 0 },
				name: currSubject.name,
				normal: { attended: 0, classes: 0 },
			};

			const prevPercent = getPercent(prevSubject.normal);
			const currPercent = getPercent(currSubject.normal);
			const minStats = getPercentStats(currSubject.normal, config["min-attendance-threshold-percent"]);
			const maxStats = getPercentStats(currSubject.normal, config["max-attendance-threshold-percent"]);
			const statusText = getStatusText(minStats, maxStats);

			// attendance for new classes have been marked
			if (currSubject.normal.classes > prevSubject.normal.classes) {
				const classesAdded = currSubject.normal.classes - prevSubject.normal.classes;
				const attendanceAdded = currSubject.normal.attended - prevSubject.normal.attended;

				const classesMissed = classesAdded - attendanceAdded;

				const notification: AttendanceNotification = {
					data: { type: "attendance-marked", subjects: [currSubject.name] },
					title: `New attendance marked in ${currSubject.name} (${currSubject.code})`,
					body: `${classesAdded} classes added, you attended ${attendanceAdded} and missed ${classesMissed}. ` +
						`Percentage changed from ${prevPercent} % to ${currPercent} %. ` +
						statusText,
				};

				if (config["only-when-absent"]) {
					if (classesMissed > 0)
						notifications.push(notification);
				} else {
					notifications.push(notification);
				}
			}

			// todo: duty leave (check: was some attendance added because of duty leave?)
		}

		return notifications;
	},
	digest: (notifications) => {
		if (notifications.length <= 2) return notifications;

		const digested: AttendanceNotification[] = [];

		const newOnes = notifications.filter((n) => n.data.type === "attendance-marked");
		if (newOnes.length > 0) {
			const subjects = Array.from(new Set(newOnes.flatMap((notification) => notification.data.subjects)));
			digested.push({
				title: "Attendance updated!",
				body: "For the following " + pluralize(subjects.length, "subject: ", "subjects: ") + subjects.join(", ") + ".",
				data: {
					type: "attendance-marked",
					subjects: subjects,
				},
			});
		}

		return digested;
	},
});

function parseAttendanceSubject(subject: attendance.Attendance): ParsedAttendanceSubject {
	const normal = subject.total_subject.split("/").map((x) => Number(x));
	const dutyLeave = subject.total_dutyleave.split("/").map((x) => Number(x));

	return {
		name: subject.subject,
		// @ts-expect-error invalid types
		code: subject.code,
		normal: {
			attended: normal[0],
			classes: normal[1],
		},
		duty_leave: {
			attended: dutyLeave[0],
			classes: dutyLeave[1],
		},
	};
}

function parseAttendance(attendance: attendance.Attendance[]): Record<string, ParsedAttendanceSubject> {
	const parsed = attendance.map(parseAttendanceSubject)
		.sort((a, b) => `${a.code}`.localeCompare(`${b.code}`));

	// lets hope that this never gets executed, because then codes will be all messed up
	const seen = new Map<string, number>();
	for (const subject of parsed) {
		const count = seen.get(subject.code) ?? 0;
		if (count > 0) subject.code += `-${count}`;
		seen.set(subject.code, count + 1);
	}

	return parsed.reduce((p, c) => {
		p[c.code] = c;
		return p;
	}, {} as Record<string, typeof parsed[number]>);
}

function getPercentStats(subject: SubjectStats, percent: number): PercentStats {
	const y = percent * subject.classes;
	return {
		cuttable: Math.floor((subject.attended - y) / percent),
		needed: Math.ceil((y - subject.attended) / (1 - percent)),
	};
}

function getPercent(subjectStats: SubjectStats): number {
	return cutePercent(safeDivision(subjectStats.attended, subjectStats.classes) * 100, 1);
}

function getStatusText(minStats: PercentStats, maxStats: PercentStats): string {
	if (minStats.needed > 0)
		return `Critical! Attend at least ${minStats.needed} more ${
			pluralize(minStats.needed, "class", "classes")
		} to stay eligible.`;
	else if (minStats.cuttable > 0) {
		if (maxStats.needed > 0)
			return `Safe. You may skip ${minStats.cuttable} ${
				pluralize(minStats.cuttable, "class", "classes")
			}. Attend ${maxStats.needed} more to reach excellent attendance.`;
		else if (maxStats.cuttable > 0)
			return `Excellent! You may skip ${minStats.cuttable} ${
				pluralize(minStats.cuttable, "class", "classes")
			}. You can skip up to ${maxStats.cuttable} and still remain excellent.`;
		else
			return `Excellent (tight). You may skip ${minStats.cuttable} ${
				pluralize(minStats.cuttable, "class", "classes")
			}, but no more.`;
	} else if (maxStats.needed > 0)
		return `Barely safe. Do not skip classes. Attend ${maxStats.needed} more to reach excellent attendance.`;
	else
		return `At minimum limit. Do not skip any classes.`;
}
