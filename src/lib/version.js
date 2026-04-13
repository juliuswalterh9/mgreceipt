import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");

let cached;

/** package.json 의 version (서버 디버그·/health 등에서 공통 사용) */
export function getAppVersion() {
  if (cached) return cached;
  try {
    cached = JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "0.0.0";
  } catch {
    cached = "0.0.0";
  }
  return cached;
}
