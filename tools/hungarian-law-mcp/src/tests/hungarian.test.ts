/**
 * Tests for Hungarian utility functions: Roman numerals, law reference parsing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  romanToArabic,
  isValidRoman,
  arabicToRoman,
  parseLawReference,
  buildNjtSlug,
} from '../utils/hungarian.js';

describe('romanToArabic', () => {
  it('converts simple Roman numerals', () => {
    assert.equal(romanToArabic('I'), 1);
    assert.equal(romanToArabic('V'), 5);
    assert.equal(romanToArabic('X'), 10);
    assert.equal(romanToArabic('L'), 50);
    assert.equal(romanToArabic('C'), 100);
  });

  it('converts compound Roman numerals', () => {
    assert.equal(romanToArabic('IV'), 4);
    assert.equal(romanToArabic('IX'), 9);
    assert.equal(romanToArabic('XL'), 40);
    assert.equal(romanToArabic('XC'), 90);
    assert.equal(romanToArabic('CD'), 400);
    assert.equal(romanToArabic('CM'), 900);
  });

  it('converts real Hungarian law numbers', () => {
    assert.equal(romanToArabic('LXXVIII'), 78); // 2017. évi LXXVIII. törvény
    assert.equal(romanToArabic('CI'), 101); // 2023. évi CI. törvény
    assert.equal(romanToArabic('CXXVIII'), 128); // 2011. évi CXXVIII. törvény
    assert.equal(romanToArabic('CCXXII'), 222); // 2015. évi CCXXII. törvény
  });

  it('is case-insensitive', () => {
    assert.equal(romanToArabic('lxxviii'), 78);
    assert.equal(romanToArabic('Ci'), 101);
  });

  it('returns null for invalid Roman numerals', () => {
    assert.equal(romanToArabic(''), null);
    assert.equal(romanToArabic('ABC'), null);
    assert.equal(romanToArabic('IIII'), null); // invalid: should be IV
    assert.equal(romanToArabic('VV'), null); // invalid: V cannot repeat
    assert.equal(romanToArabic('hello'), null);
    assert.equal(romanToArabic('123'), null);
    assert.equal(romanToArabic('XXXX'), null); // invalid: max 3 X's
  });
});

describe('isValidRoman', () => {
  it('validates correct Roman numerals', () => {
    assert.equal(isValidRoman('I'), true);
    assert.equal(isValidRoman('MCMXCIX'), true); // 1999
    assert.equal(isValidRoman('MMMCMXCIX'), true); // 3999
    assert.equal(isValidRoman('LXXVIII'), true);
  });

  it('rejects invalid Roman numerals', () => {
    assert.equal(isValidRoman(''), false);
    assert.equal(isValidRoman('IIII'), false);
    assert.equal(isValidRoman('VV'), false);
    assert.equal(isValidRoman('ABC'), false);
    assert.equal(isValidRoman('MMMM'), false); // > 3999
  });
});

describe('arabicToRoman', () => {
  it('converts Arabic to Roman', () => {
    assert.equal(arabicToRoman(78), 'LXXVIII');
    assert.equal(arabicToRoman(101), 'CI');
    assert.equal(arabicToRoman(128), 'CXXVIII');
    assert.equal(arabicToRoman(222), 'CCXXII');
    assert.equal(arabicToRoman(4), 'IV');
  });

  it('round-trips correctly', () => {
    for (const n of [1, 4, 9, 14, 42, 78, 99, 101, 128, 222, 500, 1000]) {
      assert.equal(romanToArabic(arabicToRoman(n)), n);
    }
  });
});

describe('parseLawReference', () => {
  it('parses Act references (törvény)', () => {
    const ref = parseLawReference('2017. évi LXXVIII. törvény');
    assert.ok(ref);
    assert.equal(ref.year, 2017);
    assert.equal(ref.number, 78);
    assert.equal(ref.romanNumber, 'LXXVIII');
    assert.equal(ref.type, 'törvény');
  });

  it('parses Government Decree references', () => {
    const ref = parseLawReference('191/2009. (IX. 15.) Korm. rendelet');
    assert.ok(ref);
    assert.equal(ref.year, 2009);
    assert.equal(ref.number, 191);
    assert.equal(ref.serialNumber, 191);
    assert.equal(ref.type, 'Korm. rendelet');
  });

  it('returns null for unparseable input', () => {
    assert.equal(parseLawReference('not a law reference'), null);
    assert.equal(parseLawReference(''), null);
  });

  it('returns null for invalid Roman numerals in Act references', () => {
    // "IIII" is not a valid Roman numeral
    assert.equal(parseLawReference('2017. évi IIII. törvény'), null);
    assert.equal(parseLawReference('2017. évi ABC. törvény'), null);
  });
});

describe('buildNjtSlug', () => {
  it('builds slug for törvény', () => {
    assert.equal(buildNjtSlug(2017, 78), '2017-78-00-00');
    assert.equal(buildNjtSlug(2023, 101, 'törvény'), '2023-101-00-00');
  });

  it('builds slug for rendelet', () => {
    assert.equal(buildNjtSlug(2009, 191, 'Korm. rendelet'), '2009-191-20-22');
  });
});
