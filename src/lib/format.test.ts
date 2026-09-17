import { describe, expect, it } from 'vitest';
import { timeAgo } from './format';

describe('timeAgo', () => {
  const now = new Date('2026-09-17T12:00:00Z');
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);

  it('reads recent times the way a queue is scanned', () => {
    expect(timeAgo(ago(20), now)).toBe('just now');
    expect(timeAgo(ago(5 * 60), now)).toBe('5 min ago');
    expect(timeAgo(ago(3 * 3600), now)).toBe('3 h ago');
    expect(timeAgo(ago(30 * 3600), now)).toBe('yesterday');
    expect(timeAgo(ago(6 * 86400), now)).toBe('6 days ago');
  });

  it('falls back to the date for anything older than a month', () => {
    expect(timeAgo(ago(45 * 86400), now)).toMatch(/2026/);
    expect(timeAgo('not a date', now)).toBe('—');
  });
});
