// Shared by the browser and API: boundary runs determine the separator width.
export function splitPasswordTotpLine(line) {
  const value = String(line || '').trim();
  // Match the email before looking for separators so dashes in it stay intact.
  const match = value.match(/^(.+?@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+?[a-z0-9]+)\s*(-{2,})(.*?)(-{2,})((?:[^-\r\n]|-(?!-))*)$/i);
  if (match && match[3]) {
    const [, email, left, middle, right, secret] = match;
    // A shorter run is the delimiter; excess dashes belong to the password.
    const width = Math.min(4, left.length, right.length);
    return [email.trim(), (left.slice(width) + middle + right.slice(width)).trim(), secret.trim()];
  }
  // Keep the existing API pipe format, without splitting pipes inside passwords.
  const pipe = value.match(/^([^|]+@[^|]+)\|(.+)\|([^|]+)$/);
  return pipe ? pipe.slice(1).map(part => part.trim()) : [];
}
