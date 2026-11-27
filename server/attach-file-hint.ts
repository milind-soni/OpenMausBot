// What attach_file says when the path it was given holds no file: where to save it instead, as this turn's own folders
// are (the Local VM's workspace inside the VM, else the bot's working folder on this machine), never another machine's.
export function attachNotFound(requested: string, folder: string | undefined): string {
  return `No file was found at ${requested}. Save it under ${folder ? `${folder} (your working folder)` : "your working folder"} and pass its exact path.`;
}
