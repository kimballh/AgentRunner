import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

export function loadDotenv(cwd: string): void {
  const envPath = path.join(cwd, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }
  dotenv.config({ path: envPath, override: false });
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}
