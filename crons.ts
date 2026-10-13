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

const uidOf = (u: User) => `${u.collegeId}/${u.username}`;

function getFilteredUser(entry: Deno.KvEntry<User>, options: {
	ignoreLastChecked: boolean;
	ignoreSubscribedChannels: boolean;
}): FilteredUser | null {
	const resolvedConfig = Object.keys(ServerConfig.config).reduce((p, _key) => {
		const key = _key as keyof typeof ServerConfig.config;
		p[key] = (key in entry.value.configuration && entry.value.configuration[key] != null
			? entry.value.configuration[key]
			: ServerConfig.config[key].defaultValue) as never;
		return p;
	}, {} as ConfigurationOptions<typeof ServerConfig>);

	const now = Date.now();
	const diff = Math.round(((entry.value.lastCheckedOn + resolvedConfig["min-update-interval"] * MINUTE) - now) / 1000);
	if (!options.ignoreLastChecked && diff > 0) {
		console.log(`[filter] ${uidOf(entry.value)} skipped: rate-limited, ${diff}s left`);
		return null;
	}
	if (entry.value.devices.length === 0) {
		console.log(`[filter] ${uidOf(entry.value)} skipped: no devices`);
		return null;
	}

	const subscribedChannels: NotificationChannelTags<typeof ServerConfig>[] = [];
	for (const _channelTag in entry.value.channels) {
		const channelTag = _channelTag as NotificationChannelTags<typeof ServerConfig>;
		if (!(channelTag in ServerConfig.channels)) {
			console.warn(
				`[filter] ${
					uidOf(entry.value)
				} has unknown channel '${channelTag}' in kv, ignoring (stale after config change?)`,
			);
			continue;
		}
		subscribedChannels.push(channelTag);
	}
	if (!options.ignoreSubscribedChannels && subscribedChannels.length === 0) {
		console.log(`[filter] ${uidOf(entry.value)} skipped: no subscribed channels`);
		return null;
	} // unsubscribe bro, wasting the compute

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
	const uid = uidOf(user.data);
	const runStart = Date.now();
	console.log(`[run] ${uid} start, channels=[${user.channels.join(", ")}]`);

	const settledResults = await Promise.allSettled(user.channels.map(async (channel) => {
		if (user.data.channels[channel] == null) return;

		// check if any of the subscribed-to sub-channels are active
		const subscribedItems: string[] = user.data.channels[channel].items;
		if (subscribedItems.length === 0) {
			console.log(`[${channel}] ${uid} skipped: no items subscribed`);
			return;
		}
		const activeItems: string[] = Object.entries(ServerConfig.channels[channel].items)
			.filter(([, item]) => item.active === true).map(([item]) => item);
		if (activeItems.length === 0) {
			console.log(`[${channel}] ${uid} skipped: no items active server-side`);
			return;
		}
		const channelHandler = channelHandlers[channel];

		console.log("found handler?:", channelHandler != null);
		if (channelHandler == null) {
			console.log(`[${channel}] ${uid} skipped: handler not implemented`);
			return;
		}

		// deno-lint-ignore no-explicit-any
		const channelItems = intersect(subscribedItems, activeItems) as any;
		const fetchStart = Date.now();
		const current = await channelHandler.fetch(proxyCall, user.config, channelItems);
		const currentHash = await hexSha256(JSON.stringify(current));
		const cachedHash = user.data.channels[channel].cachedHash;

		console.log(
			`[${channel}] ${uid} fetched in ${Date.now() - fetchStart}ms items=[${channelItems.join(", ")}] hash=${
				currentHash.slice(0, 8)
			} cached=${cachedHash?.slice(0, 8) ?? "none"}`,
		);

		if (cachedHash != null && cachedHash === currentHash) {
			console.log(`[${channel}] ${uid} unchanged`);
			return; // no changes, no notifications.
		}

		if (cachedHash != null) {
			console.log("comparing for changes");
			// if its not the first time.
			const cached = await kv.get<Uint8Array>(["cache", user.data.collegeId, user.data.username, channel]);
			if (cached.value != null) {
				// compare and send notifications
				const decompressedCache = await decompress<typeof current>(cached.value);
				const compiledNotifications = channelHandler.compile(decompressedCache, current, user.config, channelItems);
				console.log(`[${channel}] ${uid} changed: compiled ${compiledNotifications.length} notification(s)`);

				if (compiledNotifications.length > 0) {
					totalNotificationsCount += compiledNotifications.length;
					channelNotifications.push({
						channel: channel,
						notifications: compiledNotifications,
					});
				}
			} else {
				// note: this is not supposed to happen.
				console.warn(
					`[${channel}] ${uid} cache desync (hash present, cache missing), resetting baseline, changes this round are lost`,
				);
				// note: the following two lines are already covered by the other next two lines
				// await kv.delete(["cache", user.collegeId, user.username, channel]);
				// user.channels[channel].cachedHash = null;
			}
		} else {
			console.log(`[${channel}] ${uid} first fetch, baseline stored, no notifications`);
		}

		user.data.channels[channel].cachedHash = currentHash; // do all user related things in one go.
		deferredKvOps.set(["cache", user.data.collegeId, user.data.username, channel], await compress(current));
	}));

	for (const [i, result] of settledResults.entries()) {
		const channel = user.channels[i];
		if (user.data.channels[channel] == null) continue; // wont ever happene

		if (result.status === "rejected") {
			console.error(
				`[${channel}] ${uid} failed:`,
				result.reason instanceof ProxyError ? `proxy status ${result.reason.statusCode}` : result.reason,
			);
			if (result.reason != null && result.reason instanceof ProxyError) {
				if (result.reason.statusCode === 401) {
					console.warn(`[${channel}] ${uid} proxy 401: deregistering user, clearing cache`);
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
			console.warn(
				`[${channel}] ${uid} consecutive fails=${
					user.data.channels[channel].fails
				}/${env.MAX_PER_CHANNEL_CONSECUTIVE_FAIL_COUNT}`,
			);

			if (user.data.channels[channel].fails >= env.MAX_PER_CHANNEL_CONSECUTIVE_FAIL_COUNT) {
				console.warn(`[${channel}] ${uid} unsubscribed after too many fails`);
				delete user.data.channels[channel];
			}
		} else if (user.data.channels[channel].fails !== 0) {
			// fulfilled currently, but had failed before.
			console.log(`[${channel}] ${uid} recovered after ${user.data.channels[channel].fails} fail(s)`);
			user.data.channels[channel].fails = 0;
		} else {
			// no hiccups
		}
	}

	if (totalNotificationsCount > env.DIGESTION_REQUIRED_NOTIFICATIONS_LIMIT) {
		console.log(
			`[digest] ${uid} ${totalNotificationsCount} notifications > limit ${env.DIGESTION_REQUIRED_NOTIFICATIONS_LIMIT}, digesting`,
		);
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
			console.log(`[digest] ${uid} ${channelNotifications[i].channel}: ${before} -> ${digested.length}`);
			if (digested.length < before) { // if some reduction was done
				wasDigestionSucessful = true;
			}
			totalNotificationsCount -= before - digested.length;
			channelNotifications[i].notifications = digested;

			if (totalNotificationsCount <= env.DIGESTION_REQUIRED_NOTIFICATIONS_LIMIT) {
				break;
			}
		}

		if (!wasDigestionSucessful && totalNotificationsCount > env.DIGESTION_REQUIRED_NOTIFICATIONS_LIMIT) { // todo: digestions gives back the same thing. send some, and queue some.
			console.warn(`[digest] ${uid} stalled at ${totalNotificationsCount}, sending over-limit`);
			break;
		}
	}

	const flattenedNotifications = channelNotifications.map((cn) => cn.notifications).flat();
	console.log(
		`[send] ${uid} ${flattenedNotifications.length} notification(s) -> ${user.data.devices.length} device(s)`,
		flattenedNotifications.map((n) => n.title),
	);
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
				console.error("Failed to send notification");
				if (error instanceof WebPushError) {
					user.data.devices[i].fails++;
					console.error(
						`[push] ${uid} device=${device.id} status=${error.statusCode} fails=${
							user.data.devices[i].fails
						}/${env.MAX_PER_DEVICE_CONSECUTIVE_FAIL_COUNT} body=${String(error.body).slice(0, 200)}`,
					);

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
					console.error(`[push] ${uid} device=${device.id} unexpected error`, error);
					throw new Error("failed");
				}
			}
		}));
	}));

	if (failedDeviceIds.size > 0) {
		console.warn(`[push] ${uid} dropping ${failedDeviceIds.size} device(s): ${[...failedDeviceIds].join(", ")}`);
		user.data.devices = user.data.devices.filter((d) => !failedDeviceIds.has(d.id));
	}

	deferredKvOps.set(
		user.key,
		{
			...user.data,
			lastCheckedOn: now,
		} satisfies User,
	);
	const commit = await deferredKvOps.commit();
	if (!commit.ok) {
		console.error(
			`[run] ${uid} kv commit FAILED: cache/lastCheckedOn not saved, same notifications will re-send next run`,
		);
	}
	console.log(
		`[run] ${uid} done in ${Date.now() - runStart}ms sent=${notificationsSent} devices=${user.data.devices.length}`,
	);

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

				console.error(
					`[health] ${uidOf(user.data)} device=${device.id} status=${error.statusCode} fails=${
						user.data.devices[i].fails
					}`,
				);

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
				console.error(`[health] ${uidOf(user.data)} device=${device.id} unexpected error`, error);
				throw new Error("failed");
			}
		}
	}));

	if (failedDeviceIds.size > 0) {
		console.warn(`[health] ${uidOf(user.data)} dropping ${failedDeviceIds.size} device(s)`);
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
		(entry) =>
			getFilteredUser(entry, {
				ignoreLastChecked: true,
				ignoreSubscribedChannels: true,
			}),
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

async function crox() {
	console.log("Starting cron: fetch and send notifications");
	const cronStart = Date.now();
	const users = await Array.fromAsync(
		kv.list<User>({ prefix: ["users"] }),
		(entry) =>
			getFilteredUser(entry, {
				ignoreLastChecked: false,
				ignoreSubscribedChannels: false,
			}),
	);

	const filteredUsers: FilteredUser[] = users.filter((user) => user != null);
	console.log(
		`[cron] ${users.length} users in kv, ${filteredUsers.length} eligible, ${
			users.length - filteredUsers.length
		} skipped`,
	);

	const settledResults = await Promise.allSettled(
		filteredUsers.map((user) =>
			fetchAndSendNotifications(Date.now(), user).then((result) => {
				if (result == null) console.warn(`[cron] ${uidOf(user.data)} deregistered`);
				else {
					console.log(`[cron] ${uidOf(user.data)} sent=${result.notificationsSent} devices=${result.devicesCount}`);
				}
				return result;
			})
		),
	);
	const summary = settledResults.reduce((acc, r, i) => {
		if (r.status === "rejected") {
			console.error(`[cron] ${uidOf(filteredUsers[i].data)} run crashed:`, r.reason);
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
}

// await crox();

Deno.cron("Fetch and send notifications", { minute: { every: 5 } }, crox);
