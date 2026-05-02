import { $ZodType } from "@zod/zod/v4/core";
import type { ServerConfig } from "./server_config.ts";
import type { ErrorCodes, PROXY_RESPONSE_CACHE_STATUS } from "./constants.ts";
import type { makeCustomFetch } from "./utilities.ts";

// === Application level
export type HandleEvent = {
	auth?: { key: Deno.KvKey; user: User };
	body?: unknown;
	req: Request;
	route: string[];
};
export type Handle = (event: HandleEvent, next?: Handle) => Response | undefined | Promise<Response | undefined>;
export type ErrorCode = keyof typeof ErrorCodes;

export type ProxyResponse<T> = {
	cacheStatus: (typeof PROXY_RESPONSE_CACHE_STATUS)[keyof typeof PROXY_RESPONSE_CACHE_STATUS];
	fetchedAt: number;
	data: T;
};

// === DB stuff
export type User = {
	collegeId: number;
	username: string;
	apiKey: string;

	authToken: string;
	devices: {
		id: string;
		endpoint: string;
		expirationTime: number | null;
		keys: {
			p256dh: string;
			auth: string;
		};
		fails: number;
	}[];

	lastCheckedOn: number;
	/** Tags of notification channels user is subscribed to. */
	channels: Partial<
		{
			[K in NotificationChannelTags<typeof ServerConfig>]: {
				cachedHash: string | null;
				fails: number;
				items: (keyof (typeof ServerConfig["channels"][K]["items"]))[];
			};
		}
	>;
	/** Configuration option values overridden from the defaults */
	configuration: Partial<ConfigurationOptions<typeof ServerConfig>>;
};

// === Server
export type NotificationChannelTags<SC extends ServerConfiguration> = keyof SC["channels"];
export type ConfigurationOptions<SC extends ServerConfiguration> = {
	[K in keyof SC["config"]]: Extract<
		ServerConfiguration["config"][string],
		{ type: SC["config"][K]["type"] }
	>["defaultValue"];
};

export type NotificationChannelMethods<
	T,
	NotificationData,
	DigestedNotificationData,
	Tag extends NotificationChannelTags<typeof ServerConfig>,
> = {
	fetch: (
		request: ReturnType<typeof makeCustomFetch>,
		configuration: ConfigurationOptions<typeof ServerConfig>,
		items: (keyof (typeof ServerConfig.channels[Tag]["items"]))[],
	) => Promise<T>;
	compile: (
		previous: T,
		current: T,
		configuration: ConfigurationOptions<typeof ServerConfig>,
		items: (keyof (typeof ServerConfig.channels[Tag]["items"]))[],
	) => Notification<NotificationData>[];
	digest: (notifications: Notification<NotificationData>[]) => Notification<DigestedNotificationData>[];
};
export type ServerConfigValidators<SC extends ServerConfiguration> = {
	[K in keyof SC["config"]]: $ZodType<
		Extract<
			ServerConfiguration["config"][string],
			{ type: SC["config"][K]["type"] }
		>["defaultValue"]
	>;
};

// === Retlab
export type ServerConfiguration = {
	version: 1;
	contact: string;
	channels: Record<string, {
		name: string;
		description: string;
		items: Record<string, {
			active: boolean;
			name: string;
			description?: string;
		}>;
	}>;
	config: Record<
		string,
		& { name: string; description: string }
		& (
			| {
				type: "integer";
				defaultValue: number;
				min?: number;
				max?: number;
			}
			| { type: "boolean"; defaultValue: boolean }
			// | { type: "string"; defaultValue: string }
			// | { type: "integer-range"; defaultValue: [number, number] }
		)
	>;
};
export type Notification<T = undefined> = {
	title: string;
	body: string;
	data: T;
};

type ConfigValueMap = {
	[K in ServerConfiguration["config"][string]["type"]]: Extract<
		ServerConfiguration["config"][string],
		{ type: K }
	>["defaultValue"];
};
