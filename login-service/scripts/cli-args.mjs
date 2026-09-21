export function parseBoolean(name, value, fallback) {
  if (value == null) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`--${name} 必须是 true 或 false`);
}

export function parseInteger(name, value, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`--${name} 必须是 ${min}..${max} 的整数`);
  }
  return number;
}
