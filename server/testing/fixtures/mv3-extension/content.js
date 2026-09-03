// Sets a marker the browser-surface tests can read back over CDP. Nothing
// else: a fixture that did more would make a failing assertion ambiguous.
document.documentElement.dataset.ombExtension = "1";
