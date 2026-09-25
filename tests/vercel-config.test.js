import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

describe('vercel.json', () => {
  it('lets every API function see when the browser cancels its request', () => {
    const functions = readdirSync(new URL('../api/', import.meta.url));
    expect(functions).toEqual(expect.arrayContaining(['classify.mjs', 'search.mjs']));
    expect(functions.every((name) => name.endsWith('.mjs'))).toBe(true);
    expect(config.functions['api/*.mjs'].supportsCancellation).toBe(true);
  });
});
