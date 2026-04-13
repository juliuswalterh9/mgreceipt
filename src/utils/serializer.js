export function toSafeJson(data) {
  return JSON.parse(
    JSON.stringify(data, (_key, value) => (typeof value === "bigint" ? value.toString() : value))
  );
}
