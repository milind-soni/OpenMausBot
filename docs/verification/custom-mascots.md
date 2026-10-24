# Custom mascot profiles

Use an isolated fixture following the [verification launch guide](README.md).
Check the feature in the application renderer: the creator, file input, animated
face, and saved-shape list need UI verification.

1. From a bot's Avatar card, open **Create a custom mascot** and import a simple closed
   outline. Confirm the filename supplies the initial name, the preview keeps
   the standard gradient and animated face, and the face position/size controls
   update the preview.
2. Try a malformed SVG, an SVG with script or external-image content, and an
   outline whose face clips. Each import should show a useful error without
   losing the current draft; a clipped face must not be saveable.
3. Save two shapes on one bot, reload the app, and verify both remain listed
   and the selected shape renders. Select a built-in body and confirm the saved
   custom choices remain available.
4. Copy a saved shape from another bot and verify the destination continues to
   render it after the source bot is removed from the fixture. This copy is a
   self-contained snapshot; a shape that was never copied remains owned by its
   source bot and disappears when that bot is deleted.
5. Export and restore a team backup, then verify each restored bot retains its
   saved custom shapes. Check that the profile stores numeric outline points
   and face anchors, with no SVG markup or path-data field.

Older clients receive the compatibility `mascotBody: "cursor"` value while a
custom shape is selected, so they display the regular Cursor mascot. The
canonical selection and saved shapes remain in the bot's versioned profile.

Record before/after screenshots, a motion recording, and the fixture state
separately. Name the tested runtime, such as the browser renderer or Electron;
do not claim an installed desktop or mobile pass from browser evidence.
Importer unit tests and server responses do not verify the UI.
