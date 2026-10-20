import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PARTS = [
  ["p00-header.md", "# nestjs-slightly-better-auth: Design v"],
  ["p01-s0-s1.md", "## 0. Summary and principles"],
  ["p02-s2.md", "## 2. Package layout and public API"],
  ["p03-s3.md", "## 3. Architecture"],
  ["p04-s4.md", "## 4. Extension points"],
  ["p05-s5.md", "## 5. Module configuration"],
  ["p06a-s6-1.md", "## 6. HTTP integration"],
  ["p06f-s6-2.md", "### 6.2 "],
  ["p06b-s6-3.md", "### 6.3 "],
  ["p06c-s6-4.md", "### 6.4 "],
  ["p06g-s6-4-3.md", "#### 6.4.3 "],
  ["p06h-s6-5.md", "### 6.5 "],
  ["p06d-s6-6.md", "### 6.6 "],
  ["p06i-s6-7.md", "### 6.7 "],
  ["p06e-s6-8.md", "### 6.8 "],
  ["p06j-s6-11.md", "### 6.11 "],
  ["p07-s7.md", "## 7. Authentication"],
  ["p08-s8.md", "## 8. Authorization"],
  ["p09-s9.md", "## 9. Transports"],
  ["p10-s10.md", "## 10. Hooks"],
  ["p11-s11.md", "## 11. Types"],
  ["p12-s12.md", "## 12. Packaging"],
  ["p13-s13.md", "## 13. Error model"],
  ["p14-s14.md", "## 14. Testing strategy"],
  ["p15-s15.md", "## 15. Migration guide"],
  ["p16-s16.md", "## 16. Decision log"],
  ["p17-s17.md", "## 17. "],
  ["p18-s18.md", "## 18. Changelog"],
] as const;

const designDirectory = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (
  args.length < 2 ||
  args.length > 3 ||
  args.some((argument) => argument.trim() === "") ||
  (args.length === 3 && args[2] !== "--check")
) {
  throw new Error(
    "Usage: tsx sync-parts.mts <document> <parts-directory> [--check]",
  );
}

const [document, directory, flag] = args as [string, string, string?];
const check = flag === "--check";
const documentPath = resolve(designDirectory, document);
const partsDirectory = resolve(designDirectory, directory);
const lines = readFileSync(documentPath, "utf8")
  .replace(/\n+$/, "")
  .split("\n");
const starts = PARTS.map(([, marker]) => {
  const hits = lines.flatMap((line, index) =>
    line.startsWith(marker) ? [index] : [],
  );
  if (hits.length !== 1) {
    throw new Error(`Marker "${marker}" found ${hits.length} times`);
  }
  return hits[0];
});
if (
  starts[0] !== 0 ||
  starts.some((start, index) => index > 0 && start <= starts[index - 1])
) {
  throw new Error("Section markers are out of order");
}

const bodies = PARTS.map((_, index) =>
  lines
    .slice(starts[index], starts[index + 1] ?? lines.length)
    .join("\n")
    .replace(/\n+$/, ""),
);
if (bodies.join("\n\n") !== lines.join("\n")) {
  throw new Error("Sections must be separated by exactly one blank line");
}

if (!check) {
  mkdirSync(partsDirectory, { recursive: true });
}
let changed = 0;
PARTS.forEach(([file], index) => {
  const path = join(partsDirectory, file);
  let current: string | undefined;
  try {
    current = readFileSync(path, "utf8").replace(/\n+$/, "");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  if (current === bodies[index]) {
    return;
  }
  changed++;
  console.log(`${check ? "differs" : "updated"}: ${file}`);
  if (!check) {
    writeFileSync(path, `${bodies[index]}\n`);
  }
});
console.log(
  `${PARTS.length} parts, ${changed} ${check ? "differ" : "updated"}; authoritative source: ${documentPath}`,
);
if (check && changed > 0) {
  process.exitCode = 1;
}
