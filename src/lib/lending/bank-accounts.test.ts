import { describe, expect, it } from 'vitest';
import { holderName } from './bank-accounts';

const accounts = (...names: (string | null)[]) => names.map((accountName) => ({ accountName }));

describe('holderName', () => {
  it('takes the name on the accounts, in normal case when the bank keeps capitals', () => {
    expect(holderName(accounts('ABEBE KEBEDE ALEMU', 'ABEBE KEBEDE ALEMU'))).toBe('Abebe Kebede Alemu');
    expect(holderName(accounts('Sara  Tesfaye '))).toBe('Sara Tesfaye');
  });

  it('names the person, not the business, when most accounts carry the person', () => {
    expect(holderName(accounts('KEBEDE TRADING PLC', 'ABEBE KEBEDE', 'abebe kebede'))).toBe('Abebe Kebede');
  });

  it('keeps names outside the Latin alphabet as the bank wrote them', () => {
    expect(holderName(accounts('አበበ ከበደ'))).toBe('አበበ ከበደ');
  });

  it('gives nothing when no account carries a usable name', () => {
    expect(holderName(accounts(null, '', '12345', '<b>x</b>'))).toBeNull();
    expect(holderName([])).toBeNull();
  });
});
