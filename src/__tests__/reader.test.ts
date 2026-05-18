import { describe, it, expect } from 'vitest';
import { extractUserText } from '../reader';

describe('extractUserText', () => {
  it('returns trimmed text for plain strings', () => {
    expect(extractUserText('  hello world  ')).toBe('hello world');
  });

  it('returns null for empty string', () => {
    expect(extractUserText('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(extractUserText('   ')).toBeNull();
  });

  it('returns null for strings starting with <', () => {
    expect(extractUserText('<command>do something</command>')).toBeNull();
  });

  it('extracts text from array of text blocks', () => {
    expect(extractUserText([
      { type: 'text', text: 'fix the bug' },
    ])).toBe('fix the bug');
  });

  it('joins multiple text blocks', () => {
    expect(extractUserText([
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ])).toBe('hello world');
  });

  it('filters out non-text blocks', () => {
    expect(extractUserText([
      { type: 'tool_result', text: 'ignored' },
      { type: 'text', text: 'keep this' },
    ])).toBe('keep this');
  });

  it('filters out blocks whose text starts with <', () => {
    expect(extractUserText([
      { type: 'text', text: '<command>slash</command>' },
      { type: 'text', text: 'real message' },
    ])).toBe('real message');
  });

  it('returns null for an empty array', () => {
    expect(extractUserText([])).toBeNull();
  });

  it('returns null when all blocks are filtered', () => {
    expect(extractUserText([
      { type: 'text', text: '<wrapped>' },
    ])).toBeNull();
  });
});
