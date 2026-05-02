import z from "@zod/zod";
import webpush from "web-push";
import { generateApiKey } from "./crypto.ts";
import { env } from "./env.ts";
import { requireAuth } from "./middlewares.ts";
import { ServerConfig, Validators } from "./server_config.ts";
import type { ConfigurationOptions, Handle, NotificationChannelTags, User } from "./types.d.ts";
import { areEqual, hexSha256, kv, r, sign } from "./utilities.ts";

export const register: Handle = async (event) => {
	const parsed = z.object({
		collegeId: z.coerce.number().int(),
		username: z.coerce.string().nonempty(),
		authToken: z.string().nonempty(),
	}).parse(event.body);

	const userCount = await Array.fromAsync(kv.list({ prefix: ["users"] }, { limit: env.MAX_ACTIVE_USERS + 1 }));
	if (userCount.length >= env.MAX_ACTIVE_USERS) {
		return r.error("BAD_REQUEST", "Server is full");
	}

	// don't need this! right?
	// try {
	// 	const response = await proxyFetch({
	// 		collegeId: parsed.collegeId,
	// 		username: parsed.username,
	// 		authToken: parsed.authToken,
	// 		endpoint: ApiEndPoints.PROFILE_URL,
	// 		method: "GET",
	// 	});
	// 	const data = await response.json() as dash.ProfileResponse & { login: boolean };
	// 	if (!data.login) throw new Error("duh");
	// } catch {
	// 	return r.error("BAD_REQUEST", "Failed to get profile and authorize");
	// }

	// todo: should whitelist allow already registered people?
	const existingUser = await kv.get<User>(["users", parsed.collegeId, parsed.username]);
	if (existingUser.value == null) {
		const apiKey = "rn_" + generateApiKey();

		await kv.set(
			["users", parsed.collegeId, parsed.username],
			{
				apiKey: apiKey,
				collegeId: parsed.collegeId,
				username: parsed.username,
				authToken: parsed.authToken,
				lastCheckedOn: Date.now(),
				channels: {
					attendance: {
						cachedHash: null,
						fails: 0,
						items: ["new_attendance_marked"],
					},
					assignments: {
						cachedHash: null,
						fails: 0,
						items: ["new_assignments", "last_date_nearing", "results"],
					},
					series_exams: {
						cachedHash: null,
						fails: 0,
						items: ["results"],
					},
					surveys: {
						cachedHash: null,
						fails: 0,
						items: ["teacher_evaluation", "course_exit", "general"],
					},
				},
				configuration: {},
				devices: [],
			} satisfies User,
		);

		return r.ok(sign({ apiKey: apiKey }));
	} else {
		if (parsed.authToken !== existingUser.value.authToken) {
			// update the access token
			await kv.set(
				existingUser.key,
				{
					...existingUser.value,
					authToken: parsed.authToken,
				} satisfies User,
			);
		}

		return r.ok(sign({ apiKey: existingUser.value.apiKey }));
	}
};

export const unregister: Handle = async (event) => {
	requireAuth(event);

	// clear all cache
	const atomicDelete = kv.atomic(); // note: under the hope that channels are less than maximum number of transactions
	for await (const entry of kv.list({ prefix: ["cache", event.auth.user.collegeId, event.auth.user.username] })) {
		atomicDelete.delete(entry.key);
	}
	// clear the user
	atomicDelete.delete(event.auth.key);

	await atomicDelete.commit();
	return r.ok(sign(true));
};

export const subscribe: Handle = async (event) => {
	requireAuth(event);
	const parsed = z.object({
		subscription: z.object({
			endpoint: z.httpUrl(),
			expirationTime: z.number().nullable(),
			keys: z.object({
				p256dh: z.string(),
				auth: z.string(),
			}),
		}),
	}).parse(event.body);

	if (event.auth.user.devices.length >= env.MAX_SUBSCRIPTIONS_PER_USER) {
		return r.error("BAD_REQUEST", `Reached the subscription limit of ${env.MAX_SUBSCRIPTIONS_PER_USER} devices`);
	}

	const id = await hexSha256(parsed.subscription.endpoint);
	const alreadyExists = event.auth.user.devices.some((d) => d.id === id);
	if (alreadyExists) {
		return r.ok(sign(true)); // idempotent
	}

	event.auth.user.devices.push({
		id: id,
		endpoint: parsed.subscription.endpoint,
		expirationTime: parsed.subscription.expirationTime,
		keys: parsed.subscription.keys,
		fails: 0,
	});
	await kv.set(event.auth.key, event.auth.user);

	await webpush.sendNotification(
		{
			endpoint: parsed.subscription.endpoint,
			keys: parsed.subscription.keys,
			expirationTime: parsed.subscription.expirationTime,
		},
		JSON.stringify({
			title: "Notification check",
			body: "Are you seeing this?",
		}),
	);

	return r.ok(sign(true));
};

export const getSubscription: Handle = (event) => {
	requireAuth(event);
	const subscriptionId = z.hash("sha256", { enc: "hex" }).parse(event.route[2]);
	return r.ok(
		sign(event.auth.user.devices.findIndex((sub) => sub.id === subscriptionId) >= 0),
	);
};

export const updateSubscription: Handle = async (event) => {
	requireAuth(event);
	const subscriptionId = z.hash("sha256", { enc: "hex" }).parse(event.route[2]);
	const parsed = z.object({
		subscription: z.object({
			endpoint: z.httpUrl(),
			expirationTime: z.number().nullable(),
			keys: z.object({
				p256dh: z.string(),
				auth: z.string(),
			}),
		}),
	}).parse(event.body);

	const subIndex = event.auth.user.devices.findIndex((sub) => sub.id === subscriptionId);
	if (subIndex < 0) {
		return r.error("NOT_FOUND", "Subscription doesn't exist");
	}

	event.auth.user.devices[subIndex] = {
		id: await hexSha256(parsed.subscription.endpoint),
		endpoint: parsed.subscription.endpoint,
		expirationTime: parsed.subscription.expirationTime,
		keys: parsed.subscription.keys,
		fails: 0,
	};

	await kv.set(event.auth.key, event.auth.user);
	return r.ok(sign(true));
};

export const getConfiguration: Handle = (event) => {
	requireAuth(event);

	return r.ok(sign({
		serverConfig: ServerConfig,
		subscribedChannels: Object.entries(event.auth.user.channels).reduce((p, [channelTag, { items }]) => {
			p[channelTag] = items;
			return p;
		}, {} as Record<string, string[]>),
		overriddenConfig: event.auth.user.configuration,
	}));
};

export const setConfiguration: Handle = async (event) => {
	requireAuth(event);
	const parsed = z.object({
		channels: z.record(z.string(), z.array(z.string())),
		config: z.record(z.string(), z.unknown()),
	}).parse(event.body);

	const parsedConfigOptions = z
		.object(Validators, { error: "Invalid configuration passed" })
		.partial()
		.safeParse(parsed.config);
	if (!parsedConfigOptions.success) {
		return r.error(
			"BAD_REQUEST",
			"Invalid configuration options",
			z.flattenError(parsedConfigOptions.error).fieldErrors,
		);
	}

	for (const _key in parsedConfigOptions.data) {
		const optionKey = _key as keyof ConfigurationOptions<typeof ServerConfig>;
		if (parsedConfigOptions.data[optionKey] == null) {
			delete parsedConfigOptions.data[optionKey];
			continue;
		}
		if (
			areEqual(
				ServerConfig.config[optionKey].type,
				parsedConfigOptions.data[optionKey],
				ServerConfig.config[optionKey].defaultValue,
			)
		) {
			delete parsedConfigOptions.data[optionKey]; // not really overridden.
			continue;
		}
	}

	const updatedChannels: User["channels"] = {};

	for (const _tag in parsed.channels) {
		const tag = _tag as NotificationChannelTags<typeof ServerConfig>;
		if (parsed.channels[tag] == null || parsed.channels[tag].length === 0 || !(tag in ServerConfig.channels)) {
			delete parsed.channels[tag]; // dont error just ignore
			continue;
		}
		const subscribedItems = parsed.channels[tag];
		const actualItems = Object.keys(ServerConfig.channels[tag].items);
		const extraShit = new Set(subscribedItems).difference(new Set(actualItems));
		if (extraShit.size !== 0) {
			return r.error(
				"BAD_REQUEST",
				"Invalid channel items: " + Array.from(extraShit).join(", "), // yeah, those are actual keys and not names ik.
			);
		}

		updatedChannels[tag] = {
			cachedHash: event.auth.user.channels[tag]?.cachedHash ?? null,
			fails: event.auth.user.channels[tag]?.fails ?? 0,
			// deno-lint-ignore no-explicit-any
			items: subscribedItems as any, // I don't have the patience for this
		};
	}

	// some kv ops: (lets do together to reduce expense)
	const atomicOps = kv.atomic();

	// clear old cache of removed channels:
	const removedChannels = new Set(Object.keys(event.auth.user.channels))
		.difference(new Set(Object.keys(parsed.channels)));
	for (const tag of removedChannels) {
		atomicOps.delete(["cache", event.auth.user.collegeId, event.auth.user.username, tag]);
	}
	// store the updated user:
	atomicOps.set(
		event.auth.key,
		{
			...event.auth.user,
			channels: updatedChannels,
			configuration: parsedConfigOptions.data,
		} satisfies User,
	);
	await atomicOps.commit();

	return r.ok(sign(true));
};

export const unsubscribe: Handle = async (event) => {
	requireAuth(event);
	const parsed = z.object({
		subscription: z.object({
			id: z.hash("sha256", { enc: "hex" }),
		}),
	}).parse(event.body);

	const index = event.auth.user.devices.findIndex((sub) => sub.id === parsed.subscription.id);
	if (index !== -1) {
		event.auth.user.devices.splice(index, 1);
		await kv.set(event.auth.key, event.auth.user);
	}

	return r.ok(sign(true));
};
