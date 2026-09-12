import { describe, it, expect } from 'vitest';
import { linkify } from './linkify';

describe('linkify', () => {
  it('returns plain text unchanged as a single text segment', () => {
    expect(linkify('Open mic every Tuesday at 8pm.')).toEqual([
      { type: 'text', value: 'Open mic every Tuesday at 8pm.' },
    ]);
  });

  it('splits out a URL into its own link segment', () => {
    expect(linkify('Sign up at https://slotted.co/bearknux please.')).toEqual(
      [
        { type: 'text', value: 'Sign up at ' },
        {
          type: 'link',
          value: 'https://slotted.co/bearknux',
          href: 'https://slotted.co/bearknux',
        },
        { type: 'text', value: ' please.' },
      ],
    );
  });

  it('splits out multiple URLs', () => {
    expect(
      linkify('See https://slotted.co/bearknux or https://example.com/foo'),
    ).toEqual([
      { type: 'text', value: 'See ' },
      {
        type: 'link',
        value: 'https://slotted.co/bearknux',
        href: 'https://slotted.co/bearknux',
      },
      { type: 'text', value: ' or ' },
      {
        type: 'link',
        value: 'https://example.com/foo',
        href: 'https://example.com/foo',
      },
    ]);
  });

  it('excludes trailing sentence punctuation from the URL', () => {
    expect(linkify('Sign up at https://slotted.co/bearknux.')).toEqual([
      { type: 'text', value: 'Sign up at ' },
      {
        type: 'link',
        value: 'https://slotted.co/bearknux',
        href: 'https://slotted.co/bearknux',
      },
      { type: 'text', value: '.' },
    ]);
  });
});
