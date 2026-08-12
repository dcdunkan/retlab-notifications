import surveys from "./surveys.ts";
import attendance from "./attendance.ts";

import { ServerConfig } from "../server_config.ts";
import { NotificationChannelMethods, NotificationChannelTags } from "../types.d.ts";

export const channelHandlers: {
	// deno-lint-ignore no-explicit-any
	[K in NotificationChannelTags<typeof ServerConfig>]: NotificationChannelMethods<any, any, any, K> | null;
} = {
	series_exams: null,
	assignments: null,
	attendance: attendance,
	surveys: surveys,
};
