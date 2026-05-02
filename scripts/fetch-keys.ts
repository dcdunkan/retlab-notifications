const RET_API_URL = Deno.args[0];
if (RET_API_URL == null) {
	console.error(
		"%cerror%c: Pass Ret API URL as the only argument. E.g.: https://ret.dunked.dev/api",
		"color: red",
		"color: none",
	);
	Deno.exit(1);
}

const response = await fetch(RET_API_URL + "/keys");
await Deno.writeTextFile("./data/keys.json", JSON.stringify(await response.json()));
