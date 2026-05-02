import { associateBy } from "@std/collections/associate-by";
import { institutions } from "../generated/models.d.ts";

const response = await fetch("https://etlab.in/api/collegelistandroid.json");
const json = await response.json() as institutions.Institution;
const current = associateBy(json.colleges, (a) => a.clgId.toString());

let old: Record<string, institutions.Colleges> | null = null;

try {
	old = JSON.parse(await Deno.readTextFile("./data/college-list.json"));
} catch (err) {
	if (err instanceof Deno.errors.NotFound) {
		// ignore
	} else {
		throw err;
	}
}

if (old != null) {
	const oldKeys = new Set(Object.keys(old));
	const newKeys = new Set(Object.keys(current));

	const removed = newKeys.difference(oldKeys);
	if (removed.size > 0) {
		console.log("some colleges where removed:");
		for (const r of removed) {
			console.log(old[r].clgName, old[r].clgName, old[r].base_url);
		}
	}

	const added = oldKeys.difference(newKeys);
	for (const id of added) {
		if (isNaN(Number.parseInt(id))) {
			console.log("college with invalid id. exiting..");
			console.log(id, current[id]);
			Deno.exit(1);
		}
	}
}

await Deno.writeTextFile("./data/college-list.json", JSON.stringify(current));
console.log("output written");
