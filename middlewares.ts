import z from "@zod/zod";
import { env } from "./env.ts";
import { RET_PUBLIC_KEYS } from "./constants.ts";
import { openMessage } from "./crypto.ts";
import type { Handle, HandleEvent, User } from "./types.d.ts";
import { kv, r } from "./utilities.ts";

export function requireAuth<T extends HandleEvent>(
	event: T,
): asserts event is T & { auth: NonNullable<HandleEvent["auth"]> } {
	if (event.auth == null)
		throw new Error("auth must be present");
}

export const open: Handle = async (event, next) => {
	let openedMessage: unknown;
	try {
		const body = await event.req.json();
		openedMessage = openMessage(body, env.NOTIF_ENC_PRIVATE_KEY, RET_PUBLIC_KEYS.sign);
	} catch {
		return r.error("BAD_REQUEST", "Invalid or tampered request body");
	}
	return await next?.({ ...event, body: openedMessage });
};

export const auth: Handle = async (event, next) => {
	if (
		!event.req.headers.has("x-api-key") || !event.req.headers.has("x-username") ||
		!event.req.headers.has("x-college-id")
	) {
		return r.error("UNAUTHORIZED", "Unauthorized");
	}

	const parsed = z.object({
		collegeId: z.coerce.number().int(),
		username: z.coerce.string().nonempty(),
	}).safeParse({
		collegeId: event.req.headers.get("x-college-id"),
		username: event.req.headers.get("x-username"),
	});

	if (!parsed.success) {
		return r.error("UNAUTHORIZED", "Unauthorized");
	}

	const user = await kv.get<User>(["users", parsed.data.collegeId, parsed.data.username]);
	if (user.value != null && user.value.apiKey === event.req.headers.get("x-api-key")) {
		return await next?.({
			...event,
			auth: {
				key: user.key,
				user: user.value,
			},
		});
	}
	return r.error("UNAUTHORIZED", "Unauthorized");
};

export const compose = (...handlers: Handle[]): Handle => {
	return (event, next) => {
		const run = (index: number, event: HandleEvent): ReturnType<Handle> => {
			if (index >= handlers.length)
				return next?.(event) ?? Promise.resolve(undefined);
			return handlers[index](event, (nextEvent) => run(index + 1, nextEvent ?? event));
		};
		return run(0, event);
	};
};
