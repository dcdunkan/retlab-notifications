import { promisify } from "node:util";
import { brotliCompress, brotliDecompress } from "node:zlib";
import { BROTLI_OPTIONS, ErrorCodes, RET_PUBLIC_KEYS } from "./constants.ts";
import { createMessage } from "./crypto.ts";
import { env } from "./env.ts";
import type { ApiEndPoints } from "./generated/api-endpoints.ts";
import { ServerConfig } from "./server_config.ts";
import type {
	ConfigValueMap,
	ErrorCode,
	NotificationChannelMethods,
	NotificationChannelTags,
	ProxyResponse,
	User,
} from "./types.d.ts";

export const kv = await Deno.openKv(env.KV_PATH);

export function sign<T>(data: T) {
	return createMessage(data, env.NOTIF_SIGN_PRIVATE_KEY, RET_PUBLIC_KEYS.enc);
}
export async function hexSha256(data: string): Promise<string> {
	const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
	return new Uint8Array(hashBuffer).toHex();
}

export const r = {
	ok<T>(data: T, status = 200) {
		return Response.json({
			ok: true,
			result: data,
		}, { status: status });
	},
	error(code: ErrorCode, message: string, errors?: unknown) {
		return Response.json({
			ok: false,
			code: code,
			message: message,
			...(errors != null ? { error: errors } : {}),
		}, { status: ErrorCodes[code] });
	},
};

export class ProxyError extends Error {
	public statusCode: number;

	constructor(statusCode: number) {
		super("Proxy request failed with status code: " + statusCode);
		this.statusCode = statusCode;
	}
}

export async function proxyFetch<T>(o: {
	collegeId: number;
	username: string;
	authToken: string;
	endpoint: string;
	method: "GET" | "POST";
	body?: unknown;
}) {
	const response = await fetch(env.RET_PROXY_URL, {
		method: "POST",
		headers: { Authorization: "Bearer " + o.authToken },
		body: JSON.stringify({
			collegeId: o.collegeId,
			accountUsername: o.username,
			endpoint: o.endpoint,
			method: o.method,
			...(o.body == null ? {} : { body: JSON.stringify(o.body) }),
		}),
	});
	if (!response.ok) throw new ProxyError(response.status);
	return await response.json() as ProxyResponse<T>;
}

export function makeCustomFetch(user: User) {
	return async function <T>(endpoint: ApiEndPoints, options?: {
		method?: "GET" | "POST";
		body?: unknown;
	}): Promise<ProxyResponse<T>> {
		return await proxyFetch<T>({
			collegeId: user.collegeId,
			username: user.username,
			authToken: user.authToken,
			endpoint: endpoint,
			method: options?.method ?? "GET",
			body: options?.body,
		});
	};
}

const brotliCompressAsync = promisify(brotliCompress);
const brotliDecompressAsync = promisify(brotliDecompress);

export async function compress(data: unknown): Promise<Uint8Array> {
	const encoded = new TextEncoder().encode(JSON.stringify(data));
	const buf = await brotliCompressAsync(encoded, BROTLI_OPTIONS);
	return new Uint8Array(buf);
}

export async function decompress<T>(bytes: Uint8Array): Promise<T> {
	const buf = await brotliDecompressAsync(bytes);
	const text = new TextDecoder().decode(buf);
	return JSON.parse(text) as T;
}

export const defineChannelHandler = <
	FetchedResult,
	NotificationData,
	DigestedNotificationData,
	Tag extends NotificationChannelTags<typeof ServerConfig>,
>(
	_tag: Tag,
	methods: NotificationChannelMethods<
		FetchedResult,
		NotificationData,
		DigestedNotificationData,
		Tag
	>,
): NotificationChannelMethods<
	FetchedResult,
	NotificationData,
	DigestedNotificationData,
	Tag
> => methods;

export function areEqual<T extends keyof ConfigValueMap>(
	typeName: T,
	a: ConfigValueMap[T],
	b: ConfigValueMap[T],
): boolean {
	switch (typeName) {
		case "boolean":
			return a === b;
		case "integer":
			return a === b;
		default:
			throw new Error("unhandled type in equilator: " + typeName);
	}
}

// from retlab repo:
export function parseServerDateString(dateString: string): Date {
	const fixedDateString = dateString.replace(/(\d{2})\/(\d{2})\/(\d{4})/, "$3-$2-$1");
	return new Date(fixedDateString);
}
export function isValidDate(d: Date): boolean {
	return d instanceof Date && !isNaN(d.getTime());
}
export function pluralize(count: number, singular: string, plural: string): string {
	return count == 1 ? singular : plural;
}
