import "@std/dotenv/load";
import z from "@zod/zod";

const int = z.coerce.number().int().positive();
const string = z.coerce.string();

const ENV_SCHEMA = z.object({
	// must have stuff
	RET_PROXY_URL: z.httpUrl({ normalize: true }),
	VAPID_SUBJECT: z.url({ protocol: /^(https|mailto)$/ }),
	VAPID_PUBLIC_KEY: string.nonempty(),
	VAPID_PRIVATE_KEY: string.nonempty(),
	CONTACT_URL: z.url({ protocol: /^(https|mailto)$/ }),

	NOTIF_SIGN_PRIVATE_KEY: string.nonempty(),
	NOTIF_SIGN_PUBLIC_KEY: string.nonempty(),
	NOTIF_ENC_PRIVATE_KEY: string.nonempty(),
	NOTIF_ENC_PUBLIC_KEY: string.nonempty(),

	KV_PATH: string.optional(),

	PORT: int.optional(),
	HOSTNAME: string.optional(),
	TLS_CERT_PEM: string.optional(),
	TLS_CERT_KEY_PEM: string.optional(),

	// actual configs
	MAX_ACTIVE_USERS: int.optional().default(50),
	MAX_SUBSCRIPTIONS_PER_USER: int.optional().default(4),
	MAX_PER_DEVICE_CONSECUTIVE_FAIL_COUNT: int.optional().default(50),
	MAX_PER_CHANNEL_CONSECUTIVE_FAIL_COUNT: int.optional().default(100),
	DIGESTION_REQUIRED_NOTIFICATIONS_LIMIT: int.optional().default(10),
});
export const env = ENV_SCHEMA.parse(Deno.env.toObject());
