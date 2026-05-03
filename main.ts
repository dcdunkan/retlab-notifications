import "./crons.ts"; // https://docs.deno.com/deploy/reference/cron/#organizing-cron-declarations

import { ZodError } from "@zod/zod";
import webpush from "web-push";
import { type PublicKeys } from "./crypto.ts";
import { env } from "./env.ts";
import { auth, compose, open } from "./middlewares.ts";
import type { Handle } from "./types.d.ts";
import { kv, r, sign } from "./utilities.ts";
import * as routes from "./routes.ts";

webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);

Deno.serve({
	port: env.PORT,
	hostname: env.HOSTNAME,
	cert: env.TLS_CERT_PEM,
	key: env.TLS_CERT_KEY_PEM,
	onError: (error) => {
		console.error(error);
		if (error instanceof ZodError) {
			return r.error("BAD_REQUEST", "Invalid body"); // todo: make all zod schemas better and return more appropriate messages
		}
		return r.error("INTERNAL_SERVER_ERROR", "Internal Server Error");
	},
}, async (req) => {
	const { pathname, searchParams } = new URL(req.url);
	const route = pathname.split("/");
	console.info(req.method, pathname);

	const run = async (handler: Handle): Promise<Response> => {
		const response = await handler({ req, route });
		if (response != null) return response;
		return r.error("INTERNAL_SERVER_ERROR", "Failed to resolve a response");
	};

	if (req.method === "GET") {
		if (route[1] === "health") {
			return r.ok(sign(true));
		} else if (route[1] === "keys") {
			// note: dont encrypt this one
			return r.ok<PublicKeys>({
				sign: env.NOTIF_SIGN_PUBLIC_KEY,
				enc: env.NOTIF_ENC_PUBLIC_KEY,
			});
		} else if (route[1] === "vapid-key") {
			return r.ok(sign({ vapidKey: env.VAPID_PUBLIC_KEY }));
		} else if (route[1] === "subscription") {
			return await run(compose(auth, routes.getSubscription));
		} else if (route[1] === "configuration") {
			return await run(compose(auth, routes.getConfiguration));
		} else if (route[1] === "debug") {
			if (searchParams.get("token") === env.SECRET_DEBUG_TOKEN) {
				return Response.json(await kv.get(route.slice(2)));
			}
		}
	} else if (req.method === "POST") {
		if (route[1] === "register") {
			return await run(compose(open, routes.register));
		} else if (route[1] === "subscribe") {
			return await run(compose(open, auth, routes.subscribe));
		}
	} else if (req.method === "PUT") {
		if (route[1] === "subscription") {
			return await run(compose(open, auth, routes.updateSubscription));
		} else if (route[1] === "configuration") {
			return await run(compose(open, auth, routes.setConfiguration));
		}
	} else if (req.method === "DELETE") {
		if (route[1] === "unregister") {
			return await run(compose(auth, routes.unregister));
		} else if (route[1] === "unsubscribe") {
			return await run(compose(open, auth, routes.unsubscribe));
		}
	}

	return r.error("NOT_FOUND", "Not found");
});
