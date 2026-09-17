import { describe, expect, it } from 'vitest';
import {
  allowedPlaceholders,
  checkTemplateBody,
  MAX_TEMPLATE_LENGTH,
  renderTemplate,
  SAMPLE_VALUES,
  smsParts,
  TEMPLATE_DEFINITIONS,
  TEMPLATES_BY_CODE,
} from './notification-templates';
import { businessHour } from './business-date';

const reminder = TEMPLATES_BY_CODE.get('DUE_REMINDER')!;

describe('default templates', () => {
  it('pass the same check an operator edit must pass, in both languages', () => {
    for (const definition of TEMPLATE_DEFINITIONS) {
      expect(checkTemplateBody(definition, definition.bodyEn, definition.code)).toBeNull();
      expect(checkTemplateBody(definition, definition.bodyAm, definition.code)).toBeNull();
    }
  });

  it('have an example value for every placeholder, so the preview never shows a blank', () => {
    for (const definition of TEMPLATE_DEFINITIONS) {
      for (const name of allowedPlaceholders(definition)) expect(SAMPLE_VALUES[name], name).toBeDefined();
    }
  });
});

describe('renderTemplate', () => {
  it('fills placeholders', () => {
    expect(renderTemplate('{platform}: {amount} due {dueDate}', { platform: 'SME', amount: 'ETB 10.00', dueDate: '1 Oct' })).toBe(
      'SME: ETB 10.00 due 1 Oct'
    );
  });

  it('leaves no trailing or doubled space behind an empty value', () => {
    const rejected = TEMPLATES_BY_CODE.get('APPLICATION_REJECTED')!;
    expect(renderTemplate(rejected.bodyEn, { platform: 'SME', applicationNo: 'AP-1', reason: '' })).toBe(
      'SME: your application AP-1 was not approved.'
    );
    expect(renderTemplate('a {x}  b', { x: '' })).toBe('a b');
  });
});

describe('checkTemplateBody', () => {
  it('refuses a placeholder the message is not given, naming the ones it is', () => {
    const problem = checkTemplateBody(reminder, '{amout} is due on {dueDate}', 'English');
    expect(problem).toContain('{amout}');
    expect(problem).toContain('{amount}');
  });

  it('refuses empty and oversized bodies', () => {
    expect(checkTemplateBody(reminder, '   ', 'English')).toMatch(/empty/);
    expect(checkTemplateBody(reminder, 'x'.repeat(MAX_TEMPLATE_LENGTH + 1), 'English')).toMatch(/longer/);
  });
});

describe('smsParts', () => {
  it('counts plain text at 160 per part, split at 153', () => {
    expect(smsParts('a'.repeat(160))).toMatchObject({ parts: 1, unicode: false });
    expect(smsParts('a'.repeat(161))).toMatchObject({ parts: 2, unicode: false });
  });

  it('drops to 70 per part as soon as Amharic appears', () => {
    expect(smsParts('ሀ'.repeat(70))).toMatchObject({ parts: 1, unicode: true });
    expect(smsParts('ሀ'.repeat(71))).toMatchObject({ parts: 2, unicode: true });
  });
});

describe('businessHour', () => {
  it('reads the clock in business time, across the UTC midnight', () => {
    // 22:30 UTC is 01:30 in Addis Ababa, already the next day.
    expect(businessHour(new Date('2026-09-17T22:30:00Z'))).toBe(1);
    expect(businessHour(new Date('2026-09-17T06:00:00Z'))).toBe(9);
  });
});
