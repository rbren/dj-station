import { readFileSync } from 'node:fs';

/** The app's stylesheet as one string, the way the build sees it:
 *  `src/styles.css` is an @import index over `src/styles/`, and the
 *  tests that pin CSS rules want the whole cascade. */
export function appCss(): string {
  const index = readFileSync('src/styles.css', 'utf-8');
  return [...index.matchAll(/@import '\.\/(styles\/[^']+)';/g)]
    .map((m) => readFileSync(`src/${m[1]}`, 'utf-8'))
    .join('\n');
}
