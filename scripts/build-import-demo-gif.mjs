#!/usr/bin/env node
/**
 * Turn the import review's demo recording into the GIF the fork's readme
 * shows.
 *
 * The recording is a Playwright video — a webm — because that is what a
 * browser can produce. A GIF is what a README can show, so the video is
 * converted here, once, by hand.
 *
 * The conversion is two passes, because a GIF has 256 colours and a
 * screen recording has thousands. The first pass builds a palette from
 * the frames; the second pass draws the frames with it. A single-pass
 * conversion quantises every frame on its own, and the result flickers.
 *
 * Usage:
 *   node scripts/build-import-demo-gif.mjs [recording.webm]
 *
 * The recording is deleted when the conversion succeeds: it is an
 * intermediate, not an artefact.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const recording = resolve(
  process.argv[2] ??
    join(root, 'packages/desktop-client/demo/recordings/import-review.webm'),
);

/**
 * Where the GIF lands.
 *
 * The docs site serves `packages/docs/static`, and the style guide puts
 * an image for a page in the folder that matches the page's section, with
 * the page's name in front of it. The page is
 * `docs/transactions/importing.md`, so the image is
 * `static/img/transactions/importing-...`.
 */
const output = resolve(
  root,
  'packages/docs/static/img/transactions/importing-keyboard-review.gif',
);

/**
 * The GIF's settings.
 *
 * The width is what the readme shows it at, so the GIF is recorded wide
 * and scaled to exactly that: a GIF scaled up is soft, and a GIF scaled
 * down is wasted bytes. Twelve frames a second is enough for a user
 * interface — the recording is a UI, not a film — and 128 colours is
 * enough for one too: the palette is what makes a GIF big, and a
 * screen of text and flat panels does not need 256 of them.
 */
const width = 960;
const fps = 12;
const colors = 128;

/**
 * The first second of the recording is the app booting: a white screen
 * and then the welcome page. It says nothing about the review, so it is
 * cut.
 *
 * The cut is MEASURED, not guessed. The recording writes down the moment
 * the demo budget was ready — which is when the review's story starts —
 * and that is where the cut goes. A hard-coded second would drift the
 * moment the app got faster or slower, and would quietly cut into the
 * command bar.
 */
const trimStart = readTrimStart();

function readTrimStart() {
  const file = join(dirname(recording), 'trim.json');
  if (!existsSync(file)) {
    console.warn(
      `No ${file}: the recording will be cut at its first second. ` +
        `Record one again to have the cut measured.`,
    );
    return 1;
  }
  const { start } = JSON.parse(readFileSync(file, 'utf8'));
  // A cut before the start of the video is not a cut, it is a broken
  // seek, so the number is clamped rather than trusted.
  return Math.max(0, Number(start) || 0);
}

if (!existsSync(recording)) {
  console.error(
    `No recording at ${recording}.\n` +
      `Make one:\n` +
      `  REACT_APP_NETLIFY=true yarn build:browser --skip-translations\n` +
      `  yarn workspace @actual-app/web exec playwright test --config=playwright.demo.config.ts`,
  );
  process.exit(1);
}

const palette = join(dirname(recording), 'palette.png');
mkdirSync(dirname(output), { recursive: true });

const ffmpeg = args => {
  try {
    execFileSync(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-y', ...args],
      {
        stdio: 'inherit',
      },
    );
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(
        'ffmpeg is not installed, and it is what turns the recording into ' +
          'a GIF.\n' +
          'On Debian or Ubuntu: apt install ffmpeg',
      );
      process.exit(1);
    }
    throw err;
  }
};

/** The chain both passes share, so the palette and the frames agree. */
const scale = `fps=${fps},scale=${width}:-1:flags=lanczos`;

console.log(`Reading  ${recording}`);
console.log(`Writing ${output}`);
// One: the palette, from every frame.
ffmpeg([
  '-ss',
  String(trimStart),
  '-i',
  recording,
  '-vf',
  `${scale},palettegen=stats_mode=diff:max_colors=${colors}`,
  palette,
]);

// Two: the frames, drawn with that palette.
ffmpeg([
  '-ss',
  String(trimStart),
  '-i',
  recording,
  '-i',
  palette,
  '-lavfi',
  `[0:v]${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5`,
  output,
]);

// The intermediates are not artefacts. The GIF is.
//
// The recording is the file the spec saved, and the video Playwright
// wrote in its own name beside it. Nothing else in the folder is
// touched: the folder is the demo's, but a recording someone put there
// on purpose is still theirs.
rmSync(palette, { force: true });
rmSync(recording, { force: true });
for (const file of readdirSync(dirname(recording))) {
  if (file.startsWith('page@') && file.endsWith('.webm')) {
    rmSync(join(dirname(recording), file), { force: true });
  }
}

const bytes = statSync(output).size;
console.log(
  `Done — ${(bytes / 1024 / 1024).toFixed(2)} MB, ${width} wide, ${fps} fps`,
);
if (bytes > 12 * 1024 * 1024) {
  console.warn(
    'That GIF is large for a README. Lower the frame rate or the width ' +
      'in scripts/build-import-demo-gif.mjs and record it again.',
  );
}
