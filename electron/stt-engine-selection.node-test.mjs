import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngineSelection } from './stt-engine-selection.mjs';

test('renderer paths require a native picker grant belonging to that window', () => {
  const choices = createEngineSelection();
  const owner = { isDestroyed: () => false }, other = { isDestroyed: () => false };
  assert.throws(() => choices.resolve(owner, '/downloads/program', ''), /file picker/);
  choices.grant(owner, '/selected/whisper-cli');
  assert.equal(choices.resolve(owner, '/selected/whisper-cli', ''), '/selected/whisper-cli');
  assert.throws(() => choices.resolve(other, '/selected/whisper-cli', ''), /file picker/);
  assert.throws(() => choices.resolve(owner, '/selected/other', ''), /file picker/);
  choices.grant(owner, '/replacement/whisper-cli');
  assert.throws(() => choices.resolve(owner, '/selected/whisper-cli', ''), /file picker/);
  owner.isDestroyed = () => true;
  assert.throws(() => choices.resolve(owner, '/replacement/whisper-cli', ''), /file picker/);
});

test('saved main-process paths survive reload; clearing is allowed but not arbitrary reassignment', () => {
  const choices = createEngineSelection(), owner = { isDestroyed: () => false };
  assert.equal(choices.resolve(owner, undefined, '/saved/whisper-cli'), '/saved/whisper-cli');
  assert.equal(choices.resolve(owner, '/saved/whisper-cli', '/saved/whisper-cli'), '/saved/whisper-cli');
  assert.equal(choices.resolve(owner, '', '/saved/whisper-cli'), '');
  for (const input of [null, {}, 7, '/unselected']) assert.throws(() => choices.resolve(owner, input, '/saved/whisper-cli'), /file picker/);
});
