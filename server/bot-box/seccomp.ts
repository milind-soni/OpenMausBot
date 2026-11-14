// A seccomp filter for the box, as the BPF program bubblewrap loads from a descriptor (`--seccomp FD`): the second
// layer under the mount namespace. It refuses the system calls that only reach the kernel's attack surface (mounting,
// modules, bpf, perf, userfaultfd, the kernel keyring, open_by_handle_at, setns, kexec, reboot, swap, clock setting, I/O
// ports) with EPERM; everything an engine, a shell, git, npm, python or Chrome uses stays allowed. Linux x86-64 only: on
// another architecture the filter is not loaded, and the report says so.
//
// Classic BPF, built here so the server needs no native module. Each instruction is { code, jt, jf, k } packed as
// u16 code, u8 jt, u8 jf, u32 k (little-endian, as the kernel reads struct sock_filter on x86-64).

export const SECCOMP_ARCH_X86_64 = 0xc000003e;
const SECCOMP_RET_ALLOW = 0x7fff0000, SECCOMP_RET_ERRNO = 0x00050000, SECCOMP_RET_KILL_PROCESS = 0x80000000;
const EPERM = 1;
// BPF opcodes
const BPF_LD_W_ABS = 0x20, BPF_JMP_JEQ_K = 0x15, BPF_RET_K = 0x06;
// struct seccomp_data offsets
const OFFSET_NR = 0, OFFSET_ARCH = 4;

/** x86-64 system call numbers the box refuses. */
export const DENIED_SYSCALLS: ReadonlyArray<[name: string, nr: number]> = [
  ["mount", 165], ["umount2", 166], ["pivot_root", 155], ["swapon", 167], ["swapoff", 168], ["reboot", 169],
  ["kexec_load", 246], ["kexec_file_load", 320], ["init_module", 175], ["finit_module", 313], ["delete_module", 176],
  ["bpf", 321], ["perf_event_open", 298], ["userfaultfd", 323], ["add_key", 248], ["request_key", 249], ["keyctl", 250],
  ["open_by_handle_at", 304], ["setns", 308], ["acct", 163], ["settimeofday", 164], ["clock_settime", 227],
  ["adjtimex", 159], ["clock_adjtime", 305], ["iopl", 172], ["ioperm", 173], ["quotactl", 179], ["lookup_dcookie", 212],
  ["mount_setattr", 442], ["fsmount", 432], ["fsopen", 430], ["fsconfig", 431], ["move_mount", 429], ["open_tree", 428],
];

export interface BpfInstruction { code: number; jt: number; jf: number; k: number }

/** The filter as instructions: check the architecture, then each denied number, then allow. */
export function seccompProgram(denied: ReadonlyArray<[string, number]> = DENIED_SYSCALLS): BpfInstruction[] {
  const program: BpfInstruction[] = [
    { code: BPF_LD_W_ABS, jt: 0, jf: 0, k: OFFSET_ARCH },
    // Another architecture's numbers mean something else: never run a foreign-ABI process under this filter.
    { code: BPF_JMP_JEQ_K, jt: 1, jf: 0, k: SECCOMP_ARCH_X86_64 },
    { code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_KILL_PROCESS },
    { code: BPF_LD_W_ABS, jt: 0, jf: 0, k: OFFSET_NR },
  ];
  // Each denied number jumps straight to the EPERM return at the end; a miss falls through to the next check.
  denied.forEach(([, nr], index) => program.push({ code: BPF_JMP_JEQ_K, jt: denied.length - index, jf: 0, k: nr }));
  program.push({ code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ALLOW });
  program.push({ code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ERRNO | EPERM });
  return program;
}

/** The program as the bytes bubblewrap reads. */
export function seccompBytes(program: BpfInstruction[] = seccompProgram()): Buffer {
  const bytes = Buffer.alloc(program.length * 8);
  program.forEach((instruction, index) => {
    bytes.writeUInt16LE(instruction.code, index * 8);
    bytes.writeUInt8(instruction.jt, index * 8 + 2);
    bytes.writeUInt8(instruction.jf, index * 8 + 3);
    bytes.writeUInt32LE(instruction.k >>> 0, index * 8 + 4);
  });
  return bytes;
}

/** Whether this machine can take the filter: the program hard-codes x86-64 numbers. */
export function seccompSupported(arch: string = process.arch, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "linux" && arch === "x64";
}

/** Runs the program by hand, as the kernel would, for a call: the verdict. */
export function simulate(program: BpfInstruction[], arch: number, nr: number): "allow" | "eperm" | "kill" {
  let accumulator = 0;
  for (let pc = 0; pc < program.length;) {
    const instruction = program[pc]!;
    if (instruction.code === BPF_LD_W_ABS) { accumulator = instruction.k === OFFSET_ARCH ? arch : nr; pc += 1; }
    else if (instruction.code === BPF_JMP_JEQ_K) pc += 1 + (accumulator === instruction.k ? instruction.jt : instruction.jf);
    else if (instruction.code === BPF_RET_K) return instruction.k === SECCOMP_RET_ALLOW ? "allow" : instruction.k === SECCOMP_RET_KILL_PROCESS ? "kill" : "eperm";
    else throw new Error(`unknown instruction at ${pc}`);
  }
  throw new Error("the program ran off its end");
}
