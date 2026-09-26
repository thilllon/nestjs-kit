export function getRedisToken(alias = "default"): string {
  return !alias || alias === "default"
    ? "REDIS_CLIENT"
    : `REDIS_CLIENT_${alias}`;
}
