import { VALIDATION_FAILURES, validationFailureFields } from '../../docs/validation-failure.js';
export { validationFailureFields } from '../../docs/validation-failure.js';

export function validationError(code, fields = {}, cause) {
  const safe = validationFailureFields({ ...fields, code }).validationFailure;
  if (!safe) return validationError('VALIDATION_CHALLENGE_FAILED', {}, cause);
  return Object.assign(new Error(VALIDATION_FAILURES[code], cause ? { cause } : undefined), safe);
}

export function decodeBrowserFailure(value) {
  const safe = validationFailureFields(value).validationFailure;
  return safe ? validationError(safe.code, safe) : validationError('BROWSER_PROTOCOL_ERROR');
}
