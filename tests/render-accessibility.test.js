import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const colors = (block) => Object.fromEntries(
  [...block.matchAll(/(--[\w-]+):\s*(#[\da-f]+);/gi)].map((match) => [match[1], match[2]])
);
const light = colors(css.match(/:root\s*\{([^}]+)/)[1]);
const dark = { ...light, ...colors(css.match(/\[data-theme="dark"\]\s*\{([^}]+)/)[1]) };

function luminance(hex) {
  let value = hex.slice(1);
  if (value.length === 3) value = [...value].map((digit) => digit + digit).join('');
  const [red, green, blue] = value.match(/../g)
    .map((channel) => parseInt(channel, 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrast(foreground, background) {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe('text contrast', () => {
  for (const [name, theme] of [['light', light], ['dark', dark]]) {
    it(`keeps regular button, metadata, link, and stat text readable in the ${name} theme`, () => {
      const pairs = [
        ['--button-text', '--accent'],
        ['--button-text', '--accent-strong'],
        ['--button-disabled-text', '--button-disabled'],
        ...['--text', '--muted', '--muted-2', '--accent', '--likes-text', '--reposts-text']
          .flatMap((foreground) => ['--card-bg', '--accent-soft'].map((background) => [foreground, background])),
      ];
      for (const [foreground, background] of pairs) {
        expect(contrast(theme[foreground], theme[background]), `${foreground} on ${background}`)
          .toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
