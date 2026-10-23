#!/usr/bin/env node
// Open an isolated minimal preview containing all five task statuses.
import { randomBytes } from "node:crypto";
import path from "node:path";

import { SKILL, read, start, update } from "./dashboard.mjs";

const example = read(path.join(SKILL, "assets", "example.json"));
const result = await start({ session: "template-demo-" + randomBytes(4).toString("hex"), title: example.title, goal: example.goal, open: process.argv.includes("--open") });
result.revision = update(result.session, example).revision;
console.log(JSON.stringify(result));
