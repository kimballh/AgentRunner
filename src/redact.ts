const SECRET_PATTERNS = [
  /([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|DATABASE_URL)[A-Z0-9_]*=)([^\s]+)/gi,
  /(postgres(?:ql)?:\/\/[^:\s]+:)([^@\s]+)(@)/gi,
];

export function redactSecrets(value: string): string {
  return value
    .replace(SECRET_PATTERNS[0]!, (_match, prefix: string) => `${prefix}[REDACTED]`)
    .replace(SECRET_PATTERNS[1]!, (_match, prefix: string, _secret: string, suffix: string) => `${prefix}[REDACTED]${suffix}`);
}
