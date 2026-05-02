const RET_API_URL = Deno.args[0];
if (RET_API_URL == null) {
	throw new Error("Pass Ret API URL as the only argument. E.g.: https://ret.dunked.dev/api");
}

const response = await fetch(RET_API_URL + "/keys");
await Deno.writeTextFile("./data/keys.json", JSON.stringify(await response.json()));
