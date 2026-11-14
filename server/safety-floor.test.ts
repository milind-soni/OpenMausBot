// The never-list is a string classifier: every case here only calls
// floorVerdict or floorReading with a command line. Nothing in this file runs
// a command.
//
// HOW TO READ THE TABLES. The platform picks the reading, and nothing else:
//
//   - macOS and Linux read a line as a POSIX shell line, against the POSIX
//     rules only. A cmd command is NOT evaluated there, and neither is a
//     PowerShell one outside `pwsh -c` (see the exception below).
//   - Windows reads a line twice, as POSIX (Git Bash, WSL) and as cmd and
//     PowerShell, each against its own rules. A hit in either blocks.
//
// A row with no platform is asserted on all three. In BLOCKED, a row tagged
// "win32" is a cmd, PowerShell or Git Bash spelling: it must block on Windows
// and must NOT be blocked on macOS or Linux. "posix" means macOS and Linux
// only; what Windows makes of those ALLOWED rows is pinned in NOT_CLEAR, which
// lists what reading every line twice costs there.
//
// THE WINDOWS ROWS ARE NOT USED BY THE GATE YET. server/safety-floor-gate.ts
// applies the floor on macOS and Linux only: reading every line as two shells
// leaves too many ordinary Windows commands unread. The win32 rows keep the
// Windows reading tested through the platform argument, for the piece that
// will know which shell a request is for.
//
// One exception to "POSIX only" on macOS and Linux: PowerShell 7 runs there,
// so what follows `pwsh -c` / `powershell -Command` is read both as a POSIX
// line and as PowerShell deleting POSIX paths. Nothing outside that wrapper
// gets a second reading.
import { describe, expect, it } from "vitest";

import { floorReading, floorVerdict, MAX_COMMAND_LENGTH } from "./safety-floor.ts";

type Platform = "darwin" | "linux" | "win32";
const PLATFORMS: Platform[] = ["darwin", "linux", "win32"];
const POSIX: Platform[] = ["darwin", "linux"];
type Case = [command: string, rule: string, platform?: Platform | "posix"];

const BLOCKED: Case[] = [
  // the filesystem root, in every flag spelling
  ["rm -rf /", "delete-root"],
  ["rm -fr /", "delete-root"],
  ["rm -r /", "delete-root"],
  ["rm -R /", "delete-root"],
  ["rm -Rf /", "delete-root"],
  ["rm --recursive /", "delete-root"],
  ["rm --recursive --force /", "delete-root"],
  ["rm -r -f /", "delete-root"],
  ["rm -f -r /", "delete-root"],
  ["rm / -rf", "delete-root"],
  ["rm -rfv /", "delete-root"],
  ["rm -rf /*", "delete-root"],
  ["rm -rf --no-preserve-root /", "delete-root"],
  ["rm --no-preserve-root -rf /", "delete-root"],
  ["rm -rf -- /", "delete-root"],
  ["rm -rf /tmp/scratch /", "delete-root"],
  // quotes, trailing slashes and dot segments
  ['rm -rf "/"', "delete-root"],
  ["rm -rf '/'", "delete-root"],
  ["rm -rf //", "delete-root"],
  ["rm -rf /.", "delete-root"],
  ["rm -rf /..", "delete-root"],
  ["rm -rf /./", "delete-root"],
  ["rm -rf /usr/..", "delete-root"],
  ["rm -rf /tmp/../", "delete-root"],
  ['rm -rf "/"*', "delete-root"],
  // the home directory itself
  ["rm -rf ~", "delete-home"],
  ["rm -rf ~/", "delete-home"],
  ["rm -rf ~/.", "delete-home"],
  ["rm -rf ~/*", "delete-home"],
  ["rm -rf $HOME", "delete-home"],
  ['rm -rf "$HOME"', "delete-home"],
  ["rm -rf ${HOME}", "delete-home"],
  ['rm -rf "${HOME}/"', "delete-home"],
  ["rm -rf $HOME/*", "delete-home"],
  ["rm -rf ~/Documents/..", "delete-home"],
  ["rm -rf ~/..", "delete-home"],
  // top-level system directories
  ["rm -rf /etc", "delete-system-directory"],
  ["rm -rf /etc/", "delete-system-directory"],
  ["rm -rf '/etc'", "delete-system-directory"],
  ["rm -rf /usr", "delete-system-directory"],
  ["rm -rf /bin", "delete-system-directory"],
  ["rm -rf /sbin", "delete-system-directory"],
  ["rm -rf /var", "delete-system-directory"],
  ["rm -rf /var/*", "delete-system-directory"],
  ["rm -rf /System", "delete-system-directory"],
  ["rm -rf /Library", "delete-system-directory"],
  ["rm -rf /Applications", "delete-system-directory"],
  ["rm -rf /Users", "delete-system-directory"],
  ["rm -rf /home", "delete-system-directory"],
  ["rm -rf /boot", "delete-system-directory"],
  ["rm -rf /lib", "delete-system-directory"],
  ["rm -rf /lib64", "delete-system-directory"],
  ["rm -rf /lib*", "delete-system-directory"],
  ["rm -rf /private/var", "delete-system-directory", "darwin"],
  ["rm -rf /private", "delete-system-directory", "darwin"],
  ["rm -rf /tmp/../etc", "delete-system-directory"],
  ["rm -rf /usr/local/..", "delete-system-directory"],
  ["rm -rf /users", "delete-system-directory", "darwin"],
  ["rm -rf /ETC", "delete-system-directory", "darwin"],
  // prefixes and wrappers
  ["sudo rm -rf /", "delete-root"],
  ["sudo -n rm -rf /", "delete-root"],
  ["sudo -u root rm -rf /etc", "delete-system-directory"],
  ["sudo --user root rm -rf /", "delete-root"],
  ["doas rm -rf /", "delete-root"],
  ["doas -u root rm -rf ~", "delete-home"],
  ["FORCE=1 rm -rf /", "delete-root"],
  ['A=1 B="two words" rm -rf /usr', "delete-system-directory"],
  ["env FOO=bar rm -rf /", "delete-root"],
  // `env -S LINE` / `--split-string=LINE`: env runs what it splits LINE into
  ["env -S 'rm -rf /'", "delete-root"],
  ['env -S"rm -rf /"', "delete-root"],
  ["env -iS 'rm -rf /'", "delete-root"],
  ["env --split-string='rm -rf /'", "delete-root"],
  ["env --split-string 'rm -rf /'", "delete-root"],
  ["env --split='rm -rf /'", "delete-root"],
  ["/usr/bin/env -S 'rm -rf' /", "delete-root"],
  ["env -S '-i FOO=1 rm -rf /'", "delete-root"],
  ["env -S '-S \"rm -rf /\"'", "delete-root"],
  ["env -S 'sh -c \"rm -rf /\"'", "delete-root"],
  ["sudo env -S 'rm -rf /etc'", "delete-system-directory"],
  ['env -S "rm -rf $HOME"', "delete-home"],
  ["nohup rm -rf / &", "delete-root"],
  ["command rm -rf /", "delete-root"],
  ["exec rm -rf /", "delete-root"],
  ["/bin/rm -rf /", "delete-root"],
  ["\\rm -rf /", "delete-root"],
  ["'rm' -rf /", "delete-root"],
  ["sh -c 'rm -rf /'", "delete-root"],
  ['bash -lc "rm -rf /"', "delete-root"],
  ['bash -c "rm -rf $HOME"', "delete-home"],
  ["bash -c 'rm -rf \"$HOME\"'", "delete-home"],
  ["zsh -ic 'sudo rm -rf /etc'", "delete-system-directory"],
  ["bash -o pipefail -c 'rm -rf /'", "delete-root"],
  ["sudo sh -c \"bash -c 'rm -rf /'\"", "delete-root"],
  ["eval 'rm -rf /'", "delete-root"],
  // chains
  ["ls; rm -rf /", "delete-root"],
  ["cd /tmp && rm -rf /", "delete-root"],
  ["test -d x || rm -rf /", "delete-root"],
  ["yes | rm -rf /", "delete-root"],
  ["echo start\nrm -rf /\necho done", "delete-root"],
  ["rm -rf /;echo done", "delete-root"],
  ["(rm -rf /)", "delete-root"],
  ["{ rm -rf /; }", "delete-root"],
  ["if true; then rm -rf /; fi", "delete-root"],
  ["echo $(rm -rf /)", "delete-root"],
  ["echo `rm -rf ~`", "delete-home"],
  ["rm -rf \\\n  /", "delete-root"],
  // formatting or overwriting a disk
  ["mkfs.ext4 /dev/sda1", "format-disk"],
  ["sudo mkfs -t xfs /dev/nvme0n1p1", "format-disk"],
  ["mkfs.vfat -F 32 /dev/sdb", "format-disk"],
  ["diskutil eraseDisk JHFS+ Untitled /dev/disk2", "format-disk"],
  ["diskutil erasedisk APFS Data disk3", "format-disk"],
  ["diskutil eraseVolume APFS Scratch disk3s1", "format-disk"],
  ["sudo diskutil reformat disk2s1", "format-disk"],
  ["dd if=/dev/zero of=/dev/sda bs=1M", "overwrite-disk"],
  ["dd of=/dev/rdisk2 if=ubuntu.iso bs=4m", "overwrite-disk"],
  ["sudo dd if=image.img of=/dev/nvme0n1 status=progress", "overwrite-disk"],
  ['dd if=/dev/urandom of="/dev/hda"', "overwrite-disk"],
  ["dd if=x of=/dev/disk0", "overwrite-disk"],
  ["cat image.img > /dev/sda", "overwrite-disk"],
  ["echo boom >/dev/disk0", "overwrite-disk"],
  ["gunzip -c image.gz >> /dev/nvme0n1", "overwrite-disk"],
  ["true && : > /dev/sdb1", "overwrite-disk"],
  // fork bombs
  [":(){ :|:& };:", "fork-bomb"],
  [":() { : | : & } ; :", "fork-bomb"],
  ["bomb() { bomb | bomb & }; bomb", "fork-bomb"],
  ["function f { f | f & }; f", "fork-bomb"],
  ["bash -c ':(){ :|:& };:'", "fork-bomb"],
  // Windows: cmd
  ["rd /s /q C:\\", "delete-root", "win32"],
  ["rmdir /s /q C:\\", "delete-root", "win32"],
  ["RD /S /Q D:\\", "delete-root", "win32"],
  ["rd /s/q C:", "delete-root", "win32"],
  ['rd /s /q "C:\\"', "delete-root", "win32"],
  ["rd /s /q %USERPROFILE%", "delete-home", "win32"],
  ['rmdir /s /q "%USERPROFILE%"', "delete-home", "win32"],
  ["rd /s /q C:\\Windows", "delete-system-directory", "win32"],
  ["rmdir /S /Q C:\\Users", "delete-system-directory", "win32"],
  ['rd /s /q "C:\\Program Files"', "delete-system-directory", "win32"],
  ["rd /s /q C:\\Windows\\", "delete-system-directory", "win32"],
  ["rd /s /q %SystemRoot%", "delete-system-directory", "win32"],
  ["del /s /q C:\\*", "delete-root", "win32"],
  ["del /f /s /q C:\\Users", "delete-system-directory", "win32"],
  ["del /s /q C:\\Windows\\*.*", "delete-system-directory", "win32"],
  ["echo cleaning & rd /s /q C:\\", "delete-root", "win32"],
  ["cmd /c rd /s /q C:\\", "delete-root", "win32"],
  ['cmd.exe /c "rd /s /q C:\\Users"', "delete-system-directory", "win32"],
  ["format C:", "format-disk", "win32"],
  ["format D: /FS:NTFS /Q", "format-disk", "win32"],
  // Windows: PowerShell
  ["Remove-Item -Recurse -Force C:\\", "delete-root", "win32"],
  ["Remove-Item C:\\Users -Recurse", "delete-system-directory", "win32"],
  ['Remove-Item -Recurse -Force "C:\\Program Files"', "delete-system-directory", "win32"],
  ["Remove-Item -Path C:\\Windows -Recurse -Force", "delete-system-directory", "win32"],
  ["Remove-Item -Recurse $env:USERPROFILE", "delete-home", "win32"],
  ['Remove-Item -Recurse -Force "$env:USERPROFILE"', "delete-home", "win32"],
  ["Remove-Item -Recurse -Force $HOME", "delete-home", "win32"],
  ["ri -r C:\\Windows", "delete-system-directory", "win32"],
  ["remove-item -rec c:\\", "delete-root", "win32"],
  ['powershell -Command "Remove-Item -Recurse -Force C:\\"', "delete-root", "win32"],
  ["pwsh -c 'Remove-Item -Recurse $HOME'", "delete-home"],
  ["powershell.exe -NoProfile -Command Remove-Item -Recurse C:\\Users", "delete-system-directory", "win32"],
  ["rm -r -fo C:\\", "delete-root", "win32"],
  ["rm -Recurse -Force C:\\Windows", "delete-system-directory", "win32"],
  // Windows: Git Bash and WSL spellings of a drive
  ["rm -rf /c", "delete-root", "win32"],
  ["rm -rf /c/Users", "delete-system-directory", "win32"],
  // review round 1: an option's value written against its letter
  ["sudo -uroot rm -rf /", "delete-root"],
  ["sudo -uubuntu rm -rf /", "delete-root"],
  ["sudo -uroot bash -c 'rm -rf /'", "delete-root"],
  ["sudo -nu root rm -rf /", "delete-root"],
  ["sudo -Eu root rm -rf /etc", "delete-system-directory"],
  // review round 1: mkfs on any device that is not scratch
  ["mkfs.ext4 /dev/md0", "format-disk"],
  ["mkfs.xfs -f /dev/mapper/rhel-root", "format-disk"],
  ["mkfs.ext4 /dev/ubuntu-vg/ubuntu-lv", "format-disk"],
  ["mkfs.ext4 /dev/dm-0", "format-disk"],
  ["mkfs.btrfs -f /dev/md/root", "format-disk"],
  ["dd if=image.img of=/dev/md0", "overwrite-disk"],
  ["dd if=image.img of=/dev/mapper/rhel-root", "overwrite-disk"],
  // review round 1: cmd and PowerShell chains, where a backslash ends a path
  ["cd C:\\; Remove-Item -Recurse -Force C:\\Windows", "delete-system-directory", "win32"],
  ['cd "C:\\Users\\me\\" && rd /s /q C:\\', "delete-root", "win32"],
  ['cd "C:\\Users\\me\\"\nrd /s /q C:\\', "delete-root", "win32"],
  ['Copy-Item "C:\\a\\" D:\\b -Recurse; Remove-Item -Recurse -Force $HOME', "delete-home", "win32"],
  ['cd "C:\\proj\\"; rd /s /q C:\\Users', "delete-system-directory", "win32"],
  ['cd "C:\\Program Files\\" & rd /s /q C:\\Windows', "delete-system-directory", "win32"],
  ['Set-Location "C:\\x\\"; ri -r C:\\Windows', "delete-system-directory", "win32"],
  ['cd "C:\\x\\"; cmd /c rd /s /q C:\\Users', "delete-system-directory", "win32"],
  ['rd /s /q "C:\\Windows\\"', "delete-system-directory", "win32"],
  // review round 1: small spellings that were two lines each
  ['rm -rf "${HOME:?}"', "delete-home"],
  ["rm -rf ${HOME:?no home}/", "delete-home"],
  ["bash -c -- 'rm -rf /'", "delete-root"],
  ["function wipe { rm -rf /; }; wipe", "delete-root"],
  // review round 2: a later line that cannot be read does not undo an earlier block
  ['rm -rf /\necho "C:\\"', "delete-root"],
  ['rm -rf ~\ncd "C:\\Users\\me\\"', "delete-home"],
  ['mkfs.ext4 /dev/sda1\necho "C:\\x\\"', "format-disk"],
  ['dd if=/dev/zero of=/dev/sda\necho "C:\\x\\"', "overwrite-disk"],
  ['cat image > /dev/sda\necho "C:\\x\\"', "overwrite-disk"],
  [':(){ :|:& };:\necho "C:\\x\\"', "fork-bomb"],
  ['sudo rm -rf /etc\necho "done\\n\\"', "delete-system-directory"],
  ['rm -rf /\necho "done', "delete-root"],
  // review round 2: a keyword written against a subshell
  ["if true; then(rm -rf /); fi", "delete-root"],
  ["if(rm -rf /); then :; fi", "delete-root"],
  ["while true; do(rm -rf /); done", "delete-root"],
  ["!(rm -rf /)", "delete-root"],
  ["time(rm -rf /)", "delete-root"],
  ["{(rm -rf /)}", "delete-root"],
  ["true &&(rm -rf /)", "delete-root"],
  ["echo x;(rm -rf /)", "delete-root"],
  // review round 2: more of the re-review's inputs
  ["eval eval eval eval rm -rf /", "delete-root"],
  ["mkfs.ext4 //dev//md0", "format-disk"],
  ["sudo -Hu root rm -rf ~", "delete-home"],
  ["doas -uroot rm -rf /", "delete-root"],
  ["sudo -n -uroot -- rm -rf /", "delete-root"],
  // review round 2, Windows: a backslash before a newline, a quote or a
  // separator is a path's last character, and the next line is still read
  ["rd /s /q C:\\\n", "delete-root", "win32"],
  ["rd /s /q C:\\\necho done", "delete-root", "win32"],
  ["rd /s /q C:\\\r\necho done", "delete-root", "win32"],
  ["rd /s /q C:\\  \n", "delete-root", "win32"],
  ['rd /s /q "C:\\"\necho done', "delete-root", "win32"],
  ["rd /s /q D:\\\npause", "delete-root", "win32"],
  ["rd /s /q %USERPROFILE%\\\necho done", "delete-home", "win32"],
  ["Remove-Item -Recurse -Force C:\\\nWrite-Host done", "delete-root", "win32"],
  ["format D: /q\ndir D:\\", "format-disk", "win32"],
  ["rd /s /q C:\\Windows\ndir C:\\\necho done", "delete-system-directory", "win32"],
  ["del /s /q %USERPROFILE%\ndir D:\\\n", "delete-home", "win32"],
  ["dir C:\\\nrd /s /q C:\\Windows", "delete-system-directory", "win32"],
  ["cd C:\\Users\\me\\\nrd /s /q C:\\", "delete-root", "win32"],
  ["cd C:\\Users\\me\\ & rd /s /q C:\\Windows", "delete-system-directory", "win32"],
  ["rm -r -fo C:\\\nWrite-Host done", "delete-root", "win32"],
  ['cmd /c "rd /s /q C:\\\necho done"', "delete-root", "win32"],
  ['powershell -Command "Remove-Item -Recurse -Force C:\\\nWrite-Host done"', "delete-root", "win32"],
  ["if exist C:\\x (rd /s /q C:\\Windows)", "delete-system-directory", "win32"],
  ["if ($true) { Remove-Item -Recurse -Force C:\\ }", "delete-root", "win32"],
  // Git Bash on Windows takes a drive path
  ["rm -rf C:", "delete-root", "win32"],
  ["rm -rf C:/Users", "delete-system-directory", "win32"],
  ['rm -rf /c/Users\ncd "C:\\proj\\"', "delete-system-directory", "win32"],
  // review round 3: PowerShell 7 on macOS and Linux, inside its own wrapper
  ["pwsh -c 'rm -rf /'", "delete-root", "posix"],
  ['pwsh -NoProfile -Command "rm -rf ~"', "delete-home", "posix"],
  ["sudo pwsh -NoProfile -NonInteractive -c 'rm -rf /etc'", "delete-system-directory", "posix"],
  ["pwsh -c 'Remove-Item -Recurse -Force $HOME'", "delete-home"],
  ["pwsh -c 'Remove-Item -Recurse -Force /'", "delete-root"],
  ['pwsh -NoProfile -Command "Remove-Item -Recurse -Force $HOME"', "delete-home"],
  ["pwsh -c 'Remove-Item -Recurse -Force ~'", "delete-home"],
  ["pwsh -c 'Remove-Item -Path /etc -Recurse'", "delete-system-directory", "posix"],
  ["powershell -Command 'ri -r /usr'", "delete-system-directory", "posix"],
  ["pwsh -c 'Set-Location /tmp; Remove-Item -Recurse -Force /'", "delete-root"],
  ["pwsh -Command Remove-Item -Recurse -Force /", "delete-root"],
  // review round 4: text inside `(( … ))` and `$[ … ]` runs, so it is read.
  // A substitution inside arithmetic:
  ["(( n = $(rm -rf /etc; echo 1) ))", "delete-system-directory"],
  ["if (( $(rm -rf / ; echo 1) )); then :; fi", "delete-root"],
  ["for (( i = $(rm -rf ~; echo 0); i < 1; i++ )); do :; done", "delete-home"],
  ["while (( $(mkfs.ext4 /dev/sda1; echo 0) )); do :; done", "format-disk"],
  ["echo $[ $(rm -rf /) ]", "delete-root"],
  ['echo "$[ $(rm -rf /) ]"', "delete-root"],
  ["x=$[ `rm -rf ~` ]", "delete-home"],
  ["echo $(( $(rm -rf /) + 1 ))", "delete-root"],
  ['echo "$(( `rm -rf /` ))"', "delete-root"],
  ["bash -c 'echo $(( $(rm -rf ~) + 1 ))'", "delete-home"],
  ["n=$(( $(mkfs.ext4 /dev/sda1; echo 1) * 2 ))", "format-disk"],
  // a `((` that is two subshells:
  ["((rm -rf /) )", "delete-root"],
  ["((rm -rf /); echo done)", "delete-root"],
  ["((cd /tmp && make) || (rm -rf ~))", "delete-home"],
  ["((mkfs.ext4 /dev/sda1) )", "format-disk"],
  ["bash -c '((rm -rf ~); true)'", "delete-home"],
  ["((rm -rf /);(rm -rf ~))", "delete-root"],
  ["true && ((rm -rf /) || true)", "delete-root"],
  // and a shell with no arithmetic command at all:
  ["((rm -rf /))", "delete-root"],
  ["sh -c '((rm -rf /))'", "delete-root"],
  ["echo $[ ; rm -rf / ; echo ]", "delete-root"],
  // spellings found by probing, kept so they stay blocked
  ["RM -rf /", "delete-root"],
  ["rm -rf / >/dev/null 2>&1 &", "delete-root"],
  ["rm -rf / # clean", "delete-root"],
  ["timeout 10 rm -rf /", "delete-root"],
  ["sudo -E env PATH=/x rm -rf /", "delete-root"],
  ["while true; do rm -rf /; done", "delete-root"],
  ["case x in x) rm -rf / ;; esac", "delete-root"],
  ["x=$(rm -rf /usr)", "delete-system-directory"],
  ["dd if=/dev/zero of=/dev/disk/by-id/ata-X", "overwrite-disk"],
  ["dd if=x of=/dev/vda", "overwrite-disk"],
  ["cat x &> /dev/sdb", "overwrite-disk"],
  ["diskutil apfs eraseVolume disk1s2 -name X", "format-disk"],
  ["Remove-Item -Recurse -Force C:\\\\", "delete-root", "win32"],
  ["Remove-Item -Recurse -Force C:/", "delete-root", "win32"],
  ["Remove-Item -Recurse C:\\; echo done", "delete-root", "win32"],
  ["rd /s /q C:\\Users\\..", "delete-root", "win32"],
  ["rd /s /q %SystemDrive%\\", "delete-root", "win32"],
  ['rd /s /q "C:\\Program Files (x86)"', "delete-system-directory", "win32"],
  ['pwsh -NoProfile -Command "& { Remove-Item -Recurse -Force C:\\Users }"', "delete-system-directory", "win32"],
  ['powershell -c "rm -r -fo C:\\"', "delete-root", "win32"],
];

/** Read to the end with nothing found: `{ read: true, verdict: null }`. */
const ALLOWED: Array<[command: string, on?: Platform | "posix"]> = [
  // the same text as data
  ['git commit -m "rm -rf /"'],
  ["git commit -m 'never run: rm -rf ~'"],
  ['echo "rm -rf ~"'],
  ["echo rm -rf /"],
  ["env -S 'echo rm -rf /'"],
  ["env -S 'node --no-warnings' script.js"],
  // env hands rm a directory named "~": nothing expands it without a shell
  ["env -S 'rm -rf ~'"],
  ["printf '%s\\n' 'rm -rf /' > notes.txt"],
  ["grep -r 'mkfs' ."],
  ['rg "dd if=/dev/zero of=/dev/sda" docs'],
  ['git log --grep="rm -rf /"'],
  ["echo ':(){ :|:& };:'"],
  ['echo "format C:"'],
  ["# rm -rf /"],
  ["ls -la # then rm -rf /"],
  ["cat <<'EOF' > cleanup-notes.md\nNever run:\nrm -rf /\nEOF"],
  ["cat <<EOF\nrm -rf ~\nmkfs.ext4 /dev/sda1\nEOF\necho written"],
  ["git commit -m \"$(cat <<'EOF'\nfix: don't run rm -rf / in the installer\n\nIt was wrong; dd of=/dev/sda was worse.\nEOF\n)\"", "posix"],
  ['echo "a \\" ; rm -rf / ; \\" b"'],
  ['echo "${X:-"}"}; rm -rf /"'],
  ['git commit -m "docs: warn that \\"; rd /s /q C:\\\\ \\" is dangerous"', "posix"],
  ["cat <<< 'rm -rf /'"],
  ["cat <<-EOF\n\trm -rf /\n\tEOF"],
  ['cmd=(rm -rf /tmp/x); "${cmd[@]}"'],
  ["alias nuke='rm -rf /'"],
  ['export CLEAN_CMD="rm -rf /"'],
  ["bash -c 'echo \"rm -rf /\"'"],
  ["bash script.sh -c 'rm -rf /'"],
  ["docker run --rm alpine rm -rf /"],
  ["ssh build-host 'rm -rf /'"],
  ["man rm"],
  ["which rm mkfs dd"],
  ["command -v rm"],
  // deleting a subdirectory
  ["rm -rf ./build"],
  ["rm -rf build dist .cache node_modules"],
  ["rm -rf ~/project/dist"],
  ["rm -rf ~/.cache/pip"],
  ["rm -rf /tmp/x"],
  ["rm -rf /tmp/*"],
  ["rm -rf /var/folders/ab/cd/T/vitest-123"],
  ["rm -rf /private/var/folders/ab/cd/T/vitest-123"],
  ["rm -rf /private/tmp/claude-501/scratch"],
  ["sudo rm -rf /var/lib/apt/lists/*"],
  ["rm -rf /usr/local/lib/node_modules/typescript"],
  ["rm -rf /Applications/Example.app"],
  ["rm -rf /Library/Caches/com.example.app"],
  ["rm -rf /Users/omkar/project/dist"],
  ["rm -rf /home/omkar/project/.next"],
  ["rm -rf /opt/homebrew/Cellar/example"],
  ["rm -rf /etc/../tmp/y"],
  ["rm -rf /../tmp/x"],
  ["rm -rf /users", "linux"],
  ["rm -rf /c", "linux"],
  // not recursive, or not a delete at all
  ["rm /"],
  ["rm -f /etc/hosts.bak"],
  ["rm -f ~/notes.txt"],
  ["rmdir /tmp/empty"],
  ["mkdir -p /etc/foo"],
  ["ls -R /"],
  ["du -sh /*"],
  ["find / -name '*.log'"],
  ["cd / && ls"],
  ["chmod -R 755 /usr/local/share/example"],
  // a directory that is only named like the dangerous one
  ["rm -rf '~'"],
  ['rm -rf "~"'],
  ["rm -rf ./~"],
  ["rm -rf \\~"],
  ["rm -rf '$HOME'"],
  ["rm -rf C:", "posix"],
  ['rm -rf "%USERPROFILE%"', "darwin"],
  ['rm -rf "%USERPROFILE%"', "win32"],
  // a path nobody can know from the text
  ['rm -rf "$DIR"'],
  ["rm -rf $BUILD_DIR/"],
  ['rm -rf "${TMPDIR:-/tmp}/work"'],
  ['rm -rf "$(mktemp -d)"'],
  ["rm -rf /$NAME"],
  ["rm -rf ~/../shared-scratch"],
  ["rm -rf ~other"],
  // disks: reading, files and pseudo-devices
  ["dd of=./image.bin"],
  ["dd if=/dev/zero of=/tmp/blank.img bs=1M count=10"],
  ["dd if=/dev/sda of=backup.img"],
  ["dd if=image.iso of=/dev/null"],
  ["cat /dev/sda > disk.img"],
  ["echo done > /dev/null"],
  ["ls 2>/dev/null >&2"],
  ["echo hi > /dev/stderr"],
  ["mkfs.ext4 rootfs.img"],
  ["mkfs.fat -F 32 /dev/loop0p1"],
  ["diskutil list"],
  ["diskutil info /"],
  ["diskutil erasevolume HFS+ 'RAM Disk' $(hdiutil attach -nomount ram://2097152)"],
  ["npm run format"],
  ["prettier --write src && clang-format -i a.c"],
  // a function that is not a fork bomb
  ["build() { make | tee log & }; build"],
  // Windows
  ["rd /s /q build"],
  ["rmdir /s /q .\\dist"],
  ["rd /s /q C:\\Users\\omkar\\project\\node_modules"],
  ["rd /s /q %TEMP%\\scratch"],
  ["rd /s /q %USERPROFILE%\\Downloads\\old"],
  ["rd C:\\Windows"],
  ["del /s /q *.tmp"],
  ["del /s /q C:\\Temp\\*"],
  ["del C:\\Windows\\Temp\\a.log"],
  ["Remove-Item -Recurse -Force .\\node_modules"],
  ["Remove-Item -Recurse $env:TEMP\\work"],
  ['Remove-Item -Recurse "$env:USERPROFILE\\Downloads\\old"'],
  ["Remove-Item -Recurse '$HOME'"],
  ["Remove-Item C:\\Windows\\Temp\\a.log"],
  ["Get-ChildItem C:\\ -Recurse"],
  ["dir C:\\Windows"],
  ["Format-Table -AutoSize"],
  ["cmd /c echo rd /s /q C:\\"],
  ["rd /s /q C:\\\\Users\\\\omkar\\\\project\\\\dist"],
  ["rd /s /q \\\\server\\share\\old"],
  ["rmdir /srv/s /etc"],
  ['powershell -Command "Write-Host \'rd /s /q C:\\\'"'],
  ["rm -rf /c/Users/omkar/project/node_modules", "win32"],
  ["rm -rf C:\\Users\\omkar\\project\\dist", "win32"],
  ["rm -rf /tmp/build", "win32"],
  // review round 1: text a cmd or PowerShell line only prints
  // review round 1: escaped quotes in a POSIX line are not the end of a string
  ['curl -d "{\\"note\\": \\"then; rd /s /q C:\\\\ \\"}" https://example.test', "posix"],
  ['git commit -m "fix: handle \\"C:\\\\\\" paths; rd /s /q C:\\\\ no longer runs"'],
  // review round 1: a line that continues, or feeds a heredoc, is a POSIX line
  ["rm -rf node_modules && \\\n  npm ci", "win32"],
  ["rm -rf \\\n  /tmp/build", "win32"],
  ["cat > clean.bat <<'EOF'\nrd /s /q C:\\\nEOF", "posix"],
  ["cat <<EOF\nrm -rf /\nEOF", "win32"],
  // review round 1: a group in a path is a path nobody can know from the text
  ["rm -rf ~/(foo|bar)"],
  ["rm -rf /var/(log|tmp)/old"],
  ["rm -rf /(tmp|opt)/x"],
  ["rm -rf /tmp/!(keep)"],
  // review round 1: /mnt/<letter> is a mount on Linux, /private a directory off macOS
  ["rm -rf /mnt/x", "linux"],
  ["rm -rf /mnt/c", "linux"],
  ["rm -rf /private", "linux"],
  ["rm -rf /private/var", "linux"],
  ["sudo -udeploy rm -rf /srv/app/releases/old"],
  ['rm -rf "${HOME:?}/.cache/app"'],
  ["function clean { rm -rf ./build; }; clean"],
  ["bash -c -- 'rm -rf ./build'"],
  // review round 1: sudo -l lists what may be run and runs nothing
  ["sudo -l rm -rf /"],
  ["sudo --list rm -rf /"],
  ["sudo -nl rm -rf /"],
  // review round 1: the devices a disk image is built on, and a name only a variable knows
  ["mkfs.ext4 /dev/loop0"],
  ["mkfs.ext4 /dev/ram0"],
  ["mkfs.ext4 /dev/nbd0p1"],
  ["mkfs.ext4 /dev/zram0"],
  ["mkfs.ext4 /dev/mapper/loop0p1"],
  ['mkfs.ext4 "/dev/$DISK"'],
  ["mkfs.ext4 -J device=/dev/sdb1 rootfs.img"],
  ["dd if=image.img of=/dev/mapper/loop0p1"],
  ["dd if=/dev/zero of=/dev/ttyUSB0"],
  // review round 2: the '\'' idiom is one string to a POSIX shell
  ["git commit -m 'don'\\''t allow cd C:\\; rd /s /q C:\\ when it'\\''s chained'", "posix"],
  ["echo 'it'\\''s documented; del /s /q C:\\Users isn'\\''t allowed'", "posix"],
  ["git commit -m 'fix: don'\\''t split Windows chains\n\n- cd C:\\; Remove-Item -Recurse -Force C:\\Windows\n- it'\\''s now blocked'", "posix"],
  ["gh pr create --title 'safety floor' --body 'It doesn'\\''t allow:\n\nrd /s /q C:\\Windows\n\nand that'\\''s all'", "posix"],
  ["git commit -m 'don'\\''t run; rm -rf / because it'\\''s fatal'"],
  ["git commit -m 'don'\\''t worry; it'\\''s fine'"],
  // review round 2: text about Windows commands, in a POSIX line
  ['grep -r "rd /s" docs/'],
  ["echo 'del /s /q C:\\'"],
  ['git commit -m "remove-item -recurse C:\\Windows"'],
  ["grep -rn 'Remove-Item -Recurse -Force C:\\\\Windows' ."],
  ['echo "cd C:\\; Remove-Item -Recurse -Force C:\\Windows"'],
  ['echo "note; rd /s /q C:\\\\Windows is blocked" >> NOTES.md'],
  ["curl -d '{\"cmd\": \"rd /s /q C:\\\\\", \"next\": \"Remove-Item -Recurse C:\\\\Windows\"}' https://example.test"],
  ["jq -n --arg c 'rd /s /q C:\\' '{cmd: $c}'"],
  ["find /tmp/x -type d -empty -exec rmdir {} \\;"],
  ["sed -i 's/\\\\/\\//g' paths.txt"],
  ['docker run --rm \\\n  -v "$PWD":/w \\\n  img sh -c \'rm -rf /w/dist\''],
  ["rm -r \\\n  /tmp/build"],
  ["mkfs.ext4 /tmp/dev/sda.img"],
  // review round 5: arithmetic with no shift in it is read to the end
  ["echo $((i + 1))"],
  ["n=$(( (a + b) * 2 ))"],
  ["for i in $(seq 1 $((n - 1))); do :; done"],
  ["echo $(( $(wc -l < f) + 1 ))"],
  // review round 3: PowerShell that deletes nothing on the list
  ["pwsh -c 'Remove-Item -Recurse -Force ./build'"],
  ["pwsh -c 'Get-ChildItem /'"],
  ["pwsh -c 'Remove-Item -Force /etc/hosts.bak'"],
  ["pwsh -c 'Remove-Item -Recurse -Force $env:TEMP/work'"],
  ["pwsh -NoProfile -File cleanup.ps1"],
  ["pwsh -c 'Write-Host deleting; Get-ChildItem ~'"],
  // review round 2: ordinary cmd and PowerShell lines, clear on Windows too
  ["cd C:\\proj\\ ; npm test"],
  ["dir C:\\Users\\me\\ "],
  ["Get-ChildItem C:\\ | Remove-Item -Recurse -Force"],
  ['cd "C:\\proj\\" && rd /s /q "C:\\proj\\node_modules\\"'],
];

/** What the design does NOT call clear, pinned so the cost stays visible.
 * "unreadable" is `{ read: false }`: nothing was found, and one reading lost
 * its place, so nothing answers for the command automatically and a person
 * is asked. A rule name is a block.
 *
 * On Windows every line is read as POSIX and as cmd/PowerShell. A POSIX line
 * that quotes a Windows command can read as that command in the second
 * reading, and a Windows path quoted with a trailing backslash ("C:\dir\")
 * leaves the POSIX reading with an open quote. Neither is caught on macOS or
 * Linux, where only the POSIX reading runs. */
const NOT_CLEAR: Array<[command: string, on: Platform | "posix" | "all", outcome: string]> = [
  // PowerShell text that cannot be read, inside its wrapper on macOS and Linux
  ['pwsh -c "Write-Host \'unfinished"', "posix", "unreadable"],
  // POSIX text the cmd/PowerShell reading takes for a command
  ["git commit -m 'don'\\''t allow cd C:\\; rd /s /q C:\\ when it'\\''s chained'", "win32", "delete-root"],
  ["echo 'it'\\''s documented; del /s /q C:\\Users isn'\\''t allowed'", "win32", "delete-system-directory"],
  ["gh pr create --title 'safety floor' --body 'It doesn'\\''t allow:\n\nrd /s /q C:\\Windows\n\nand that'\\''s all'", "win32", "delete-system-directory"],
  ['git commit -m "docs: warn that \\"; rd /s /q C:\\\\ \\" is dangerous"', "win32", "delete-root"],
  ['curl -d "{\\"note\\": \\"then; rd /s /q C:\\\\ \\"}" https://example.test', "win32", "delete-root"],
  ["cat > clean.bat <<'EOF'\nrd /s /q C:\\\nEOF", "win32", "delete-root"],
  // a heredoc body with an apostrophe leaves the cmd/PowerShell reading inside a quote
  ["git commit -m \"$(cat <<'EOF'\nfix: don't run rm -rf / in the installer\n\nIt was wrong; dd of=/dev/sda was worse.\nEOF\n)\"", "win32", "unreadable"],
  // a quoted Windows path ending in a backslash leaves the POSIX reading inside a quote
  ['ls "C:\\Users\\me\\"', "all", "unreadable"],
  ['rd /s /q "C:\\proj\\node_modules\\"', "all", "unreadable"],
  ['Remove-Item -Recurse -Force "C:\\proj\\build\\"', "all", "unreadable"],
  ['cd "C:\\Program Files\\App\\" && del /q *.log', "all", "unreadable"],
  ['Write-Output "rd /s /q C:\\"', "all", "unreadable"],
  ['Write-Host "C:\\logs\\"; Write-Host "next: Remove-Item -Recurse C:\\Users"', "all", "unreadable"],
  ['cd "C:\\proj\\"; echo "cleaning; rd /s /q C:\\ skipped"', "all", "unreadable"],
  ['echo "say \\"hi\\"; rd /s /q C:\\"', "all", "unreadable"],
  // the same shape with a POSIX command in the text is a command to the POSIX reading
  ['cd "C:\\proj\\"; echo "cleaning; rm -rf / skipped"', "all", "delete-root"],
  // KNOWN LIMITATION: an arithmetic shift, in `(( … ))`, `$[ … ]` or
  // `$(( … ))`. `<<` there is read as the start of a heredoc, which then
  // never ends, so the answer is "could not read" and a person is asked.
  // Reading these as arithmetic meant skipping what is inside, and text
  // inside does run (the must-block rows for the same three forms).
  ["(( x << 1 ))", "all", "unreadable"],
  ["echo $[1<<2]", "all", "unreadable"],
  ["x=$((2 << 3)); echo $x", "all", "unreadable"],
  ["(( x << 1 ))\nrm -rf /", "all", "unreadable"],
  ["echo $[1<<2]\nrm -rf /", "all", "unreadable"],
  ["echo $((1 << 2))\nrm -rf /", "all", "unreadable"],
  // `env -S` expands `$NAME`, reads backslashes and drops `#` comments by
  // rules of its own, and a value the shell computed is not known
  ["env -S 'rm -rf ${TARGET}'", "all", "unreadable"],
  ['env -S "$CMD"', "all", "unreadable"],
  ['env -S "$(cat cmd.txt)"', "all", "unreadable"],
  ["env -S 'rm -rf \\/'", "all", "unreadable"],
  ["env -S 'rm -rf / # tidy'", "all", "unreadable"],
  ["env -S 'rm -rf \"/'", "all", "unreadable"],
  // a shortened long option may take the next word as its value: the word
  // after it is read as the command, and the line is never called clear
  ["sudo --us root rm -rf /", "all", "unreadable"],
  ["timeout --sig KILL 5 rm -rf /", "all", "unreadable"],
  ["env --uns FOO rm -rf /", "all", "unreadable"],
  ["sudo --us rm -rf /", "all", "delete-root"],
  // a wrapper nested deeper than is followed was not read
  ["eval eval eval eval eval rm -rf /", "all", "unreadable"],
];

describe("floorVerdict", () => {
  it("covers at least forty spellings each way, on every platform", () => {
    for (const host of PLATFORMS) {
      expect(BLOCKED.filter(([, , platform]) => !platform || platform === host || (platform === "posix" && host !== "win32")).length, host).toBeGreaterThanOrEqual(40);
      expect(ALLOWED.filter(([, on]) => !on || on === host || (on === "posix" && host !== "win32")).length, host).toBeGreaterThanOrEqual(40);
    }
    expect(BLOCKED.filter(([, , platform]) => platform === "win32").length).toBeGreaterThanOrEqual(40);
  });

  it.each(BLOCKED)("blocks %j as %s", (command, rule, platform) => {
    for (const host of !platform ? PLATFORMS : platform === "posix" ? POSIX : [platform]) {
      const verdict = floorVerdict(command, host);
      expect(verdict?.rule, host).toBe(rule);
      expect(verdict!.label).toMatch(/\S/);
    }
  });

  it("does not evaluate a cmd, PowerShell or Git Bash spelling on macOS or Linux", () => {
    const windowsOnly = BLOCKED.filter(([, , platform]) => platform === "win32");
    expect(windowsOnly.length).toBeGreaterThan(0);
    for (const [command] of windowsOnly) for (const host of POSIX) expect(floorVerdict(command, host), `${host}: ${command}`).toBeNull();
  });

  it.each(ALLOWED)("reads %j to the end and finds nothing", (command, on) => {
    for (const host of !on ? PLATFORMS : on === "posix" ? POSIX : [on]) {
      expect(floorReading(command, host), host).toEqual({ read: true, verdict: null });
    }
  });

  it.each(NOT_CLEAR)("%j on %s: %s", (command, on, outcome) => {
    for (const host of on === "all" ? PLATFORMS : on === "posix" ? POSIX : [on]) {
      const reading = floorReading(command, host);
      expect(reading.read ? reading.verdict?.rule ?? "clear" : "unreadable", host).toBe(outcome);
    }
  });

  it("does not call a line clear when a reading loses its place", () => {
    // nothing was found, and the rest could not be read: not "clear"
    expect(floorReading('npm test\necho "C:\\"', "linux")).toEqual({ read: false });
    expect(floorReading("echo 'unfinished", "darwin")).toEqual({ read: false });
    expect(floorReading("cat <<EOF\nno closing line", "linux")).toEqual({ read: false });
    expect(floorReading("cat <<EOF", "linux")).toEqual({ read: false });
    expect(floorReading("echo $(date", "linux")).toEqual({ read: false });
    expect(floorReading("(cd /tmp && ls", "linux")).toEqual({ read: false });
    expect(floorReading("$(".repeat(100), "linux")).toEqual({ read: false });
    // what was read before the break still counts
    expect(floorReading('rm -rf /\necho "C:\\"', "linux")).toEqual({ read: true, verdict: { rule: "delete-root", label: "recursive delete of the filesystem root" } });
    // on Windows either reading losing its place is enough
    expect(floorReading('dir "C:\\Users\\me\\"', "win32")).toEqual({ read: false });
    expect(floorReading("dir C:\\Users\\me\\", "win32")).toEqual({ read: true, verdict: null });
  });

  it("does not scan a command over the size cap, and reads a long one under it", () => {
    expect(MAX_COMMAND_LENGTH).toBe(32_768);
    const pairs = Array.from({ length: 1_100 }, (_unused, index) => `\\"k${index}\\": \\"v${index}\\"`).join(", ");
    const body = `curl -s -X POST -d "{${pairs}}" https://example.test`;
    expect(body.length).toBeGreaterThan(20_000);
    expect(body.length).toBeLessThan(MAX_COMMAND_LENGTH);
    // 2,200 escaped quotes: read to the end, on every platform, with the right answer
    for (const host of PLATFORMS) expect(floorReading(body, host), host).toEqual({ read: true, verdict: null });
    for (const host of PLATFORMS) expect(floorReading(`${body}; rm -rf /`, host), host).toMatchObject({ read: true, verdict: { rule: "delete-root" } });
    // one character over the cap is not scanned at all, whatever it holds
    const atCap = `echo ${"a".repeat(MAX_COMMAND_LENGTH - 5)}`;
    expect(atCap.length).toBe(MAX_COMMAND_LENGTH);
    expect(floorReading(atCap, "linux")).toEqual({ read: true, verdict: null });
    expect(floorReading(`${atCap}a`, "linux")).toEqual({ read: false });
    expect(floorReading(`rm -rf / ${"#".repeat(MAX_COMMAND_LENGTH)}`, "linux")).toEqual({ read: false });
    expect(floorVerdict(`rm -rf / ${"#".repeat(MAX_COMMAND_LENGTH)}`, "linux")).toBeNull();
  });

  it("names what it blocked without repeating the command", () => {
    expect(floorVerdict("rm -rf /")).toEqual({ rule: "delete-root", label: "recursive delete of the filesystem root" });
    expect(floorVerdict("rm -rf ~")).toEqual({ rule: "delete-home", label: "recursive delete of the home directory" });
    expect(floorVerdict("sudo rm -rf /etc/")).toEqual({ rule: "delete-system-directory", label: "recursive delete of /etc" });
    expect(floorVerdict("rd /s /q C:\\Windows", "win32")?.label).toBe("recursive delete of a Windows system folder (Windows)");
    expect(floorVerdict("mkfs.ext4 /dev/sda1")?.label).toBe("formatting a disk");
    expect(floorVerdict("dd if=x of=/dev/sda")?.label).toBe("overwriting a disk device");
    expect(floorVerdict(":(){ :|:& };:")?.label).toBe("a fork bomb");
    const secret = floorVerdict("TOKEN=sk-live-1234567890 rm -rf /");
    expect(JSON.stringify(secret)).not.toContain("sk-live");
  });

  it("knows the home directory by its absolute path when it is told where home is", () => {
    expect(floorVerdict("rm -rf /Users/omkar", "darwin")).toBeNull();
    expect(floorVerdict("rm -rf /Users/omkar", "darwin", "/Users/omkar")?.rule).toBe("delete-home");
    expect(floorVerdict("rm -rf /Users/omkar/", "darwin", "/Users/omkar/")?.rule).toBe("delete-home");
    expect(floorVerdict("rm -rf /users/OMKAR/*", "darwin", "/Users/omkar")?.rule).toBe("delete-home");
    expect(floorVerdict("rm -rf /home/omkar", "linux", "/home/omkar")?.rule).toBe("delete-home");
    expect(floorVerdict("rm -rf /home/Omkar", "linux", "/home/omkar")).toBeNull();
    expect(floorVerdict("rm -rf /Users/omkar/project", "darwin", "/Users/omkar")).toBeNull();
    expect(floorVerdict("rd /s /q C:\\Users\\Omkar", "win32", "C:\\Users\\omkar")?.rule).toBe("delete-home");
    expect(floorVerdict("rm -rf /c/Users/omkar", "win32", "C:\\Users\\omkar")?.rule).toBe("delete-home");
    expect(floorVerdict("rd /s /q C:\\Users\\omkar\\project", "win32", "C:\\Users\\omkar")).toBeNull();
  });

  it("does not take a scratch directory for the home directory, wherever HOME points", () => {
    // HOME=/tmp in a container, a fixture's throwaway home: deleting it is cleanup
    expect(floorVerdict("rm -rf /tmp", "linux", "/tmp")).toBeNull();
    expect(floorVerdict("rm -rf /tmp/sandbox-home", "linux", "/tmp/sandbox-home")).toBeNull();
    expect(floorVerdict("rm -rf /private/tmp", "darwin", "/private/tmp")).toBeNull();
    expect(floorVerdict("rm -rf /var/folders/ab/cd/T/omb-home", "darwin", "/var/folders/ab/cd/T/omb-home")).toBeNull();
    expect(floorVerdict("rd /s /q C:\\Users\\ci\\AppData\\Local\\Temp\\home", "win32", "C:\\Users\\ci\\AppData\\Local\\Temp\\home")).toBeNull();
    // the command that says "home" still means it
    expect(floorVerdict("rm -rf ~", "linux", "/tmp")?.rule).toBe("delete-home");
    expect(floorVerdict('rm -rf "$HOME"', "linux", "/tmp")?.rule).toBe("delete-home");
  });

  it("tells a command it read from one it could not read", () => {
    expect(floorReading("npm test")).toEqual({ read: true, verdict: null });
    expect(floorReading("rm -rf /")).toEqual({ read: true, verdict: { rule: "delete-root", label: "recursive delete of the filesystem root" } });
    expect(floorReading("")).toEqual({ read: true, verdict: null });
    // A reader that breaks part-way has not read the command. Forced here by
    // a home that cannot be read as text; nothing in the command is special.
    const broken = { replace() { throw new Error("unreadable home"); } } as unknown as string;
    expect(floorReading("rm -rf /srv/app/build", "linux", broken)).toEqual({ read: false });
    // floorVerdict keeps its plain shape: it has nothing to report for it
    expect(floorVerdict("rm -rf /srv/app/build", "linux", broken)).toBeNull();
  });

  it("never throws and never blocks text it cannot read", () => {
    const odd = [
      "", "   ", "\n\n", "'", '"', "`", "$(", "${", "rm -rf '", 'rm -rf "', "rm -rf $(", "<<", "<<EOF", ">", "2>&", "&&&&", "((((", "))))",
      "rm", "rm -rf", "sudo", "sudo -u", "env", "bash -c", "cmd /c", "powershell -Command", "\u0000rm -rf /tmp/x", "rm -rf \uE000", "rm -rf \uE001",
      "$(".repeat(5_000), "(".repeat(20_000), "a".repeat(200_000), `echo ${"x ".repeat(50_000)}`, "bash -c ".repeat(2_000) + "true",
    ];
    for (const command of odd) expect(() => floorVerdict(command), command.slice(0, 40)).not.toThrow();
    for (const command of odd) expect(floorVerdict(command), command.slice(0, 40)).toBeNull();
    expect(floorVerdict(undefined as unknown as string)).toBeNull();
    expect(floorVerdict(42 as unknown as string)).toBeNull();
  });
});
