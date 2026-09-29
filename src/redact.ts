const SECRET_PATTERNS = [
  /([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|DATABASE_URL)[A-Z0-9_]*=)([^\s]+)/gi,
  /(postgres(?:ql)?:\/\/[^:\s]+:)([^@\s]+)(@)/gi,
];

export function redactSecrets(value: string): string {
  return redactKnownSecrets(value)
    .replace(SECRET_PATTERNS[0]!, (_match, prefix: string) => `${prefix}[REDACTED]`)
    .replace(
      /("[A-Z0-9_-]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|DATABASE_URL)[A-Z0-9_-]*"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
      '$1"[REDACTED]"',
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
    .replace(
      SECRET_PATTERNS[1]!,
      (_match, prefix: string, _secret: string, suffix: string) => `${prefix}[REDACTED]${suffix}`,
    );
}

function redactKnownSecrets(value: string): string {
  for (const [key, secret] of Object.entries(process.env)) {
    if (/(TOKEN|SECRET|PASSWORD|API[_-]?KEY|DATABASE_URL)/i.test(key) && secret && secret.length >= 8)
      value = value.split(secret).join("[REDACTED]");
  }
  return value;
}
export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(redactValue) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /^(authorization|accessToken|refreshToken|clientSecret|password|apiKey)$/i.test(k.replace(/[_-]/g, ""))
          ? "[REDACTED]"
          : redactValue(v),
      ]),
    ) as T;
  return value;
}
