import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const designDirectory = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 4 || args.some((argument) => argument.trim() === "")) {
  throw new Error(
    "Usage: tsx splice.mts <document> <start-prefix> <end-prefix|__EOF__> <part-file>",
  );
}

const [document, start, end, part] = args as [string, string, string, string];
if (start === end) {
  throw new Error("Start and end prefixes must differ");
}

const documentPath = resolve(designDirectory, document);
const partPath = resolve(designDirectory, part);
const lines = readFileSync(documentPath, "utf8").split("\n");
const starts = lines.flatMap((line, index) =>
  line.startsWith(start) ? [index] : [],
);
if (starts.length !== 1) {
  throw new Error(`Start prefix "${start}" found ${starts.length} times`);
}

const first = starts[0];
let last = lines.length;
if (end !== "__EOF__") {
  const ends = lines.flatMap((line, index) =>
    index > first && line.startsWith(end) ? [index] : [],
  );
  if (ends.length !== 1) {
    throw new Error(
      `End prefix "${end}" found ${ends.length} times after the start prefix`,
    );
  }
  last = ends[0];
}

const body = readFileSync(partPath, "utf8").replace(/\n+$/, "");
const output = [
  ...lines.slice(0, first),
  ...body.split("\n"),
  "",
  ...lines.slice(last),
];
writeFileSync(documentPath, output.join("\n"));
console.log(
  `Replaced lines ${first + 1}-${last} with ${body.split("\n").length} lines from ${partPath}`,
);
