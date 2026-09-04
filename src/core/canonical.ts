import { createHash } from "node:crypto";
import type { JsonValue } from "./types.js";

export function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key] ?? null)}`)
    .join(",")}}`;
}

export function sha256(value: JsonValue): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}
