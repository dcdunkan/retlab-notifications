import { intersect } from "@std/collections/intersect";
import webpush, { WebPushError } from "web-push";
import { channelHandlers } from "./channels/mod.ts";
import { MINUTE } from "./constants.ts";
import { env } from "./env.ts";
import { ServerConfig } from "./server_config.ts";
import type { ConfigurationOptions, Notification, NotificationChannelTags, User } from "./types.d.ts";
import { compress, decompress, hexSha256, kv, makeCustomFetch, ProxyError } from "./utilities.ts";

type FilteredUser = {
	key: Deno.KvKey;
	data: User;
	config: ConfigurationOptions<typeof ServerConfig>;
	channels: NotificationChannelTags<typeof ServerConfig>[];
};

function getFilteredUser(entry: Deno.KvEntry<User>): FilteredUser | null {
	const resolvedConfig = Object.keys(ServerConfig.config).reduce((p, _key) => {
		const key = _key as keyof typeof ServerConfig.config;
		p[key] = (key in entry.value.configuration && entry.value.configuration[key] != null
			? entry.value.configuration[key]
			: ServerConfig.config[key].defaultValue) as never;
		return p;
	}, {} as ConfigurationOptions<typeof ServerConfig>);

	const now = Date.now();
	const diff = Math.round(((entry.value.lastCheckedOn + resolvedConfig["min-update-interval"] * MINUTE) - now) / 1000);
	if (diff > 0) {
		return null;
	}
	if (entry.value.devices.length === 0) return null;

	const subscribedChannels: NotificationChannelTags<typeof ServerConfig>[] = [];
	for (const _channelTag in entry.value.channels) {
		const channelTag = _channelTag as NotificationChannelTags<typeof ServerConfig>;
		if (!(channelTag in ServerConfig.channels)) continue;
		subscribedChannels.push(channelTag);
	}
	if (subscribedChannels.length === 0) return null; // unsubscribe bro, wasting the compute

	return {
		key: entry.key,
		data: entry.value,
		config: resolvedConfig,
		channels: subscribedChannels,
	};
}

type FetchAndSendResults = {
	notificationsSent: number;
	devicesCount: number;
};

async function fetchAndSendNotifications(now: number, user: FilteredUser): Promise<FetchAndSendResults | null> {
	const proxyCall = makeCustomFetch(user.data);

	let totalNotificationsCount = 0;
	const channelNotifications: {
		channel: NotificationChannelTags<typeof ServerConfig>;
		notifications: Notification[];
	}[] = [];

	const deferredKvOps = kv.atomic();

	const settledResults = await Promise.allSettled(user.channels.map(async (channel) => {
		if (user.data.channels[channel] == null) return;

		// check if any of the subscribed-to sub-channels are active
		const subscribedItems: string[] = user.data.channels[channel].items;
		if (subscribedItems.length === 0) return;
		const activeItems: string[] = Object.entries(ServerConfig.channels[channel].items)
			.filter(([, item]) => item.active === true).map(([item]) => item);
		if (activeItems.length === 0) return;

		const channelHandler = channelHandlers[channel];
		if (channelHandler == null) return;

		// deno-lint-ignore no-explicit-any
		const channelItems = intersect(subscribedItems, activeItems) as any;
		const current = await channelHandler.fetch(proxyCall, user.config, channelItems);
		const currentHash = await hexSha256(JSON.stringify(current));
		const cachedHash = user.data.channels[channel].cachedHash;

		if (cachedHash != null && cachedHash === currentHash) {
			return; // no changes, no notifications.
		}

		if (cachedHash != null) {
			// if its not the first time.
			const cached = await kv.get<Uint8Array>(["cache", user.data.collegeId, user.data.username, channel]);
			if (cached.value != null) {
				// compare and send notifications
				const decompressedCache = await decompress<typeof current>(cached.value);
				const compiledNotifications = channelHandler.compile(decompressedCache, current, user.config, channelItems);

				if (compiledNotifications.length > 0) {
					totalNotificationsCount += compiledNotifications.length;
					channelNotifications.push({
						channel: channel,
						notifications: compiledNotifications,
					});
				}
			} else {
				// note: this is not supposed to happen.
				console.warn(`Cache desync for ${user.data.username}/${channel}, resetting`);
				// note: the following two lines are already covered by the other next two lines
				// await kv.delete(["cache", user.collegeId, user.username, channel]);
				// user.channels[channel].cachedHash = null;
			}
		}

		user.data.channels[channel].cachedHash = currentHash; // do all user related things in one go.
		deferredKvOps.set(["cache", user.data.collegeId, user.data.username, channel], await compress(current));
	}));

	for (const [i, result] of settledResults.entries()) {
		const channel = user.channels[i];
		if (user.data.channels[channel] == null) continue; // wont ever happene

		if (result.status === "rejected") {
			if (result.reason != null && result.reason instanceof ProxyError) {
				if (result.reason.statusCode === 401) {
					// same as unregistration:
					// clear all cache
					const atomicDelete = kv.atomic(); // note: under the hope that channels are less than maximum number of transactions
					for await (const entry of kv.list({ prefix: ["cache", user.data.collegeId, user.data.username] })) {
						atomicDelete.delete(entry.key);
					}
					atomicDelete.delete(user.key);
					await atomicDelete.commit();
					return null;
				}
			}

			user.data.channels[channel].fails++;

			if (user.data.channels[channel].fails >= env.MAX_PER_CHANNEL_CONSECUTIVE_FAIL_COUNT) {
				delete user.data.channels[channel];
			}
		} else if (user.data.channels[channel].fails !== 0) {
			// fulfilled currently, but had failed before.
			user.data.channels[channel].fails = 0;
		} else {
			// no hiccups
		}
	}

	// digest notifications if they exceed the set limits:
	while (totalNotificationsCount > env.DIGESTION_REQUIRED_NOTIFICATIONS_LIMIT) {
		channelNotifications.sort((a, b) => b.notifications.length - a.notifications.length); // sort high to low

		// todo: picks the best option rn (highest, not the lowest), but have to implement some kind of priority selection.
		// and as to why channel with highest notification count is chosen instead of lowest: digestion is required anyway,
		// so why not pick the highest and reduce the amount of notifications to send (efficiency).

		let wasDigestionSucessful = false;

		for (let i = 0; i < channelNotifications.length; i++) {
			const channelMethods = channelHandlers[channelNotifications[i].channel];
			if (channelMethods == null) throw new Error("shouldnt happen");

			const before = channelNotifications[i].notifications.length;
			const digested = channelMethods.digest(channelNotifications[i].notifications);
			if (digested.length < before) { // if some reduction was done
				wasDigestionSucessful = true;
			}
			totalNotificationsCount -= before - digested.length;
			channelNotifications[i].notifications = digested;

			if (totalNotificationsCount <= env.DIGESTION_REQUIRED_NOTIFICATIONS_LIMIT) {
				break;
			}
		}

		if (!wasDigestionSucessful && totalNotificationsCount > env.DIGESTION_REQUIRED_NOTIFICATIONS_LIMIT)
			// todo: digestions gives back the same thing. send some, and queue some.
			break;
	}

	const flattenedNotifications = channelNotifications.map((cn) => cn.notifications).flat();

	const failedDeviceIds = new Set<string>();

	let notificationsSent = 0;

	// Send notifications to all devices parallely
	await Promise.allSettled(user.data.devices.map(async (device, i) => {
		// Send all notifications to the device parallely.

		// If sending one notification fails due to e.g. unauthorized or some other error,
		// all notifications are halted, and throws the error upwards, which is settled upstream.
		await Promise.all(flattenedNotifications.map(async (notification) => {
			try {
				await webpush.sendNotification(
					{
						endpoint: device.endpoint,
						keys: device.keys,
						expirationTime: device.expirationTime,
					},
					JSON.stringify(
						{
							title: notification.title,
							body: notification.body,
							data: notification.data,
						} satisfies Notification,
					),
				);
				notificationsSent++;

				if (device.fails > 0) {
					device.fails = 0;
				}
			} catch (error) {
				if (error instanceof WebPushError) {
					user.data.devices[i].fails++;

					if (user.data.devices[i].fails >= env.MAX_PER_DEVICE_CONSECUTIVE_FAIL_COUNT) {
						failedDeviceIds.add(device.id);
						throw new Error("failed"); // throwing makes further sending of notifications stop, doesn't it?
					}

					if (error.statusCode === 400) {
						// bbbaaaddd???
					} else if (error.statusCode === 401 || error.statusCode === 403) {
						// unauthorized means, that the server vapid key connected subscription
						// doesn't match the subscription stored. or vapid key changed or something.
						failedDeviceIds.add(device.id);
						throw new Error("failed");
					} else if (error.statusCode === 404 || error.statusCode === 410) {
						// subscription endpoint gone!
						failedDeviceIds.add(device.id);
						throw new Error("failed");
					} else if (error.statusCode === 413) {
						// WRONG server stuff.
					}
				} else {
					console.error("Something went wrong while sending out notification");
					console.error(user, device, notification);
					throw new Error("failed");
				}
			}
		}));
	}));

	user.data.devices = user.data.devices.filter((d) => !failedDeviceIds.has(d.id));

	deferredKvOps.set(
		user.key,
		{
			...user.data,
			lastCheckedOn: now,
		} satisfies User,
	);
	await deferredKvOps.commit();

	return {
		notificationsSent: notificationsSent,
		devicesCount: user.data.devices.length,
	};
}

async function sendPeriodicalHealthCheckup(user: FilteredUser): Promise<FetchAndSendResults | null> {
	const failedDeviceIds = new Set<string>();

	const notification: Notification<{ type: "health-check" }> = {
		data: { type: "health-check" },
		title: "Just checking if everything's fine",
		body: "Please ignore.",
	};

	let notificationsSent = 0;

	// Send notifications to all devices parallely
	await Promise.allSettled(user.data.devices.map(async (device, i) => {
		// Send all notifications to the device parallely.

		// If sending one notification fails due to e.g. unauthorized or some other error,
		// all notifications are halted, and throws the error upwards, which is settled upstream.
		try {
			await webpush.sendNotification(
				{
					endpoint: device.endpoint,
					keys: device.keys,
					expirationTime: device.expirationTime,
				},
				JSON.stringify(notification),
			);
			notificationsSent++;

			if (device.fails > 0) {
				device.fails = 0;
			}
		} catch (error) {
			if (error instanceof WebPushError) {
				user.data.devices[i].fails++;

				if (user.data.devices[i].fails >= env.MAX_PER_DEVICE_CONSECUTIVE_FAIL_COUNT) {
					failedDeviceIds.add(device.id);
					throw new Error("failed"); // throwing makes further sending of notifications stop, doesn't it?
				}

				if (error.statusCode === 400) {
					// bbbaaaddd???
				} else if (error.statusCode === 401 || error.statusCode === 403) {
					// unauthorized means, that the server vapid key connected subscription
					// doesn't match the subscription stored. or vapid key changed or something.
					failedDeviceIds.add(device.id);
					throw new Error("failed");
				} else if (error.statusCode === 404 || error.statusCode === 410) {
					// subscription endpoint gone!
					failedDeviceIds.add(device.id);
					throw new Error("failed");
				} else if (error.statusCode === 413) {
					// WRONG server stuff.
				}
			} else {
				console.error("Something went wrong while sending out notification");
				console.error(user, device, notification);
				throw new Error("failed");
			}
		}
	}));

	if (failedDeviceIds.size > 0) {
		user.data.devices = user.data.devices.filter((d) => !failedDeviceIds.has(d.id));
		await kv.set(user.key, user.data satisfies User);
	}

	return {
		notificationsSent: notificationsSent,
		devicesCount: user.data.devices.length,
	};
}

Deno.cron("Periodical health-check", "0 0 * * *", async () => {
	console.log("Starting cron: periodical health-check");
	const cronStart = Date.now();
	const users = await Array.fromAsync(
		kv.list<User>({ prefix: ["users"] }),
		(entry) => getFilteredUser(entry),
	);
	console.log("Found", users.length, "users from kv");

	const filteredUsers: FilteredUser[] = users.filter((user) => user != null);
	console.log("Filtered", filteredUsers.length, "eligible users");

	const settled = await Promise.allSettled(
		filteredUsers.map((user) =>
			sendPeriodicalHealthCheckup(user).then((result) => {
				if (result == null) console.warn("User has deregistered", user);
				else {
					console.log(
						`Sent ${result.notificationsSent} notifications to ${result.devicesCount} devices of user ${user.data.collegeId}/${user.data.username}`,
					);
				}
				return result;
			})
		),
	);

	const summary = settled.reduce((acc, r) => {
		if (r.status === "rejected") {
			acc.errors++;
			return acc;
		}
		if (r.value == null) {
			acc.deregistered++;
			return acc;
		}
		acc.notificationsSent += r.value.notificationsSent;
		return acc;
	}, { notificationsSent: 0, deregistered: 0, errors: 0 });

	console.log(
		`Cron done in ${
			Date.now() - cronStart
		}ms | sent=${summary.notificationsSent} deregistered=${summary.deregistered} errors=${summary.errors}`,
	);
});

Deno.cron("Fetch and send notifications", { minute: { every: 5 } }, async () => {
	console.log("Starting cron: fetch and send notifications");
	const cronStart = Date.now();
	const users = await Array.fromAsync(
		kv.list<User>({ prefix: ["users"] }),
		(entry) => getFilteredUser(entry),
	);
	console.log("Found", users.length, "users from kv");

	const filteredUsers: FilteredUser[] = users.filter((user) => user != null);
	console.log("Filtered", filteredUsers.length, "eligible users");

	const settledResults = await Promise.allSettled(
		filteredUsers.map((user) =>
			fetchAndSendNotifications(Date.now(), user).then((result) => {
				if (result == null) console.warn("User has deregistered", user);
				else {
					console.log(
						`Sent ${result.notificationsSent} notifications to ${result.devicesCount} devices of user ${user.data.collegeId}/${user.data.username}`,
					);
				}
				return result;
			})
		),
	);
	const summary = settledResults.reduce((acc, r) => {
		if (r.status === "rejected") {
			acc.errors++;
			return acc;
		}
		if (r.value == null) {
			acc.deregistered++;
			return acc;
		}
		acc.notificationsSent += r.value.notificationsSent;
		return acc;
	}, { notificationsSent: 0, deregistered: 0, errors: 0 });

	console.log(
		`Cron done in ${
			Date.now() - cronStart
		}ms | sent=${summary.notificationsSent} deregistered=${summary.deregistered} errors=${summary.errors}`,
	);
});
