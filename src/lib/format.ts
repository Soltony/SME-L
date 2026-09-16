/**
 * Display and identity formatting shared by server and client code.
 * Nothing here touches the database.
 */

export function maskPhone(phone: string | null | undefined) {
  if (!phone) return '—';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return '***';
  return `${digits.slice(0, 4)}${'*'.repeat(Math.max(0, digits.length - 6))}${digits.slice(-2)}`;
}

export function maskAccount(account: string | null | undefined) {
  if (!account) return '—';
  const text = String(account);
  if (text.length <= 4) return '****';
  return `${'*'.repeat(Math.max(4, text.length - 4))}${text.slice(-4)}`;
}

/**
 * A normalized Ethiopian number: the 251 country code and exactly nine more
 * digits. Anything else cannot be dialled and must not be stored as if it could.
 */
export function isValidEthiopianPhone(normalized: string): boolean {
  return /^251[0-9]{9}$/.test(normalized);
}

/** A line an SMS can reach: 09 (Ethio Telecom) or 07 (Safaricom). */
export function isEthiopianMobile(normalized: string): boolean {
  return /^251[79][0-9]{8}$/.test(normalized);
}

/** Normalizes Ethiopian numbers to the 251XXXXXXXXX form used as the borrower key. */
export function normalizePhone(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('251')) return digits;
  if (digits.startsWith('0')) return `251${digits.slice(1)}`;
  if (digits.length === 9) return `251${digits}`;
  return digits;
}

/** The 251XXXXXXXXX form back to the 0XXXXXXXXX one the SMS gateway addresses. */
export function toLocalPhone(raw: string): string {
  const normalized = normalizePhone(raw);
  if (!isValidEthiopianPhone(normalized)) return String(raw || '').trim();
  return `0${normalized.slice(3)}`;
}

/**
 * Rejects an entry that is not written as a phone number at all, before
 * normalization gets a chance to quietly turn "0912345678abc" into a number.
 */
export function looksLikePhoneNumber(raw: string): boolean {
  return /^[+]?[0-9 ()-]+$/.test(raw.trim());
}

/** A raw entry read as an Ethiopian mobile number, or null if it is not one. */
export function parseEthiopianMobile(raw: string): string | null {
  const trimmed = (raw || '').trim();
  if (!trimmed || !looksLikePhoneNumber(trimmed)) return null;
  const normalized = normalizePhone(trimmed);
  return isEthiopianMobile(normalized) ? normalized : null;
}

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/** Guards CSV cells against formula injection when opened in a spreadsheet. */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  // A plain signed number is not a formula; leave it numeric so totals still add up.
  const guarded = /^[=+\-@\t\r]/.test(text) && !/^-\d+(\.\d+)?$/.test(text) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header.map(csvCell).join(','), ...rows.map((row) => row.map(csvCell).join(','))].join(
    '\r\n'
  );
}
