import { describe, expect, it, vi } from 'vitest';
import { buildTempPasswordSms, deliverTempPassword } from './temp-password';

const PASSWORD = 'Kt7$mQz9wRb2Xf!';

const base = {
  fullName: 'Selam Bekele',
  phoneNumber: '251911223344',
  password: PASSWORD,
  purpose: 'CREATED' as const,
};

describe('buildTempPasswordSms', () => {
  it('carries the password and tells the holder to change it', () => {
    const body = buildTempPasswordSms(base);
    expect(body).toContain(PASSWORD);
    expect(body).toContain('Selam');
    expect(body).toMatch(/change it at first sign-in/);
  });

  it('says why the password arrived', () => {
    expect(buildTempPasswordSms(base)).toContain('account is ready');
    expect(buildTempPasswordSms({ ...base, purpose: 'RESET' })).toContain('has been reset');
  });

  it('falls back to a neutral greeting when the name is blank', () => {
    expect(buildTempPasswordSms({ ...base, fullName: '   ' })).toContain('Hi there,');
  });
});

describe('deliverTempPassword', () => {
  it('sends the message to the account holder and reports success', async () => {
    const sent: { recipient: string; body: string }[] = [];
    const result = await deliverTempPassword(base, async (recipient, body) => {
      sent.push({ recipient, body });
      return { ok: true };
    });

    expect(result).toEqual({ delivered: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].recipient).toBe('251911223344');
    expect(sent[0].body).toContain(PASSWORD);
  });

  it('prints the password to the terminal when the send fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await deliverTempPassword(base, async () => ({
        ok: false,
        error: 'Provider responded 503',
      }));

      expect(result).toEqual({ delivered: false, error: 'Provider responded 503' });
      const printed = warn.mock.calls[0]?.join(' ') ?? '';
      expect(printed).toContain(PASSWORD);
      expect(printed).toContain('251911223344');
      expect(printed).toContain('Provider responded 503');
    } finally {
      warn.mockRestore();
    }
  });

  it('treats a thrown transport as a failed send rather than propagating', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await deliverTempPassword(base, async () => {
        throw new Error('socket hang up');
      });

      expect(result.delivered).toBe(false);
      expect(result.error).toBe('socket hang up');
      expect(warn.mock.calls[0]?.join(' ')).toContain(PASSWORD);
    } finally {
      warn.mockRestore();
    }
  });

  it('never echoes the password back through the provider error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await deliverTempPassword(base, async () => ({
        ok: false,
        error: `Provider responded 400: {"message":"${PASSWORD}"}`,
      }));

      expect(result.error).not.toContain(PASSWORD);
      expect(result.error).toContain('[redacted]');
    } finally {
      warn.mockRestore();
    }
  });
});
