import { type BrotliOptions, constants } from "node:zlib";
import type { PublicKeys } from "./crypto.ts";

export const MINUTE = 60 * 1000;

export const SERVER_VERSION = 1;
export const ErrorCodes = {
	BAD_REQUEST: 400,
	UNAUTHORIZED: 401,
	NOT_FOUND: 404,
	INTERNAL_SERVER_ERROR: 500,
} as const;

export const RET_PUBLIC_KEYS: PublicKeys = JSON.parse(await Deno.readTextFile("./data/keys.json"));

export const BROTLI_OPTIONS: BrotliOptions = {
	params: {
		[constants.BROTLI_PARAM_QUALITY]: 6,
		[constants.BROTLI_PARAM_LGWIN]: 22,
		[constants.BROTLI_PARAM_LGBLOCK]: 0,
		[constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
	},
};

export const TZ_FORMATTER = new Intl.DateTimeFormat("en-IN", {
	timeZone: "Asia/Kolkata",
	dateStyle: "long",
	timeStyle: "short",
});

export const PROXY_RESPONSE_CACHE_STATUS = {
	Fresh: 0,
	Cached: 1,
	Stale: 2,
} as const;
