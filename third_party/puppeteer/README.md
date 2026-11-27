# puppeteer

The US keyboard layout in `server/browser/cdp/keyboard.ts` (`US_KEYBOARD`) is
the key definition table of [Puppeteer](https://github.com/puppeteer/puppeteer)'s
`packages/puppeteer-core/src/common/USKeyboardLayout.ts`, taken from
puppeteer-core 24.37.5 (Apache-2.0, see `LICENSE`; Copyright 2017 Google Inc.).
`keyDescription()` and the key-event fields `Keyboard` sends follow
Puppeteer's `CdpKeyboard` in `src/cdp/Input.ts` from the same release.

Modified: each definition is written on one line, the `KeyInput` type union is
left out, and the table is typed as a plain record. The driver adds OMB's own
chord parsing, macOS editing commands and Shift handling around it.
