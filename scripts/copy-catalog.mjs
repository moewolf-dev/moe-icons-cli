import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "src", "catalog", "catalog.json");
const target = join(root, "dist", "catalog", "catalog.json");
mkdirSync(dirname(target), { recursive: true });
cpSync(source, target);
