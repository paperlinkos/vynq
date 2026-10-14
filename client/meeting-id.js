const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createMeetingId(random = Math.random) {
  const chars = Array.from({ length: 12 }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
  return `VYNQ-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

export function normaliseMeetingId(value = '') {
  const compact = value.toUpperCase().trim().replace(/[^A-Z0-9]/g, '');
  if (!/^VYNQ[A-Z0-9]{12}$/.test(compact)) return null;
  return `VYNQ-${compact.slice(4, 8)}-${compact.slice(8, 12)}-${compact.slice(12)}`;
}
