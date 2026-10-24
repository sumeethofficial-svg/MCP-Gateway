// tsc does not copy .sql files; the migrator reads them from dist at runtime.
import { cpSync, mkdirSync } from "node:fs";
mkdirSync("dist/db/migrations", { recursive: true });
cpSync("src/db/migrations", "dist/db/migrations", { recursive: true });
