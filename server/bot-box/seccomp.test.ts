import { describe, expect, it } from "vitest";

import { DENIED_SYSCALLS, SECCOMP_ARCH_X86_64, X32_SYSCALL_BIT, seccompBytes, seccompProgram, seccompSupported, simulate } from "./seccomp.ts";

const denied = (name: string) => DENIED_SYSCALLS.find(([n]) => n === name)![1];

describe("the box's seccomp filter", () => {
  it("refuses each denied call with EPERM, allows everything else, and kills a foreign-architecture process", () => {
    const program = seccompProgram();
    for (const [name, nr] of DENIED_SYSCALLS) expect(simulate(program, SECCOMP_ARCH_X86_64, nr), name).toBe("eperm");
    // read, write, openat, clone, clone3, execve, unshare, ptrace, socket, connect: what engines, shells and Chrome use.
    for (const nr of [0, 1, 257, 56, 435, 59, 272, 101, 41, 42, 230, 202]) expect(simulate(program, SECCOMP_ARCH_X86_64, nr), String(nr)).toBe("allow");
    expect(simulate(program, 0xc00000b7, denied("mount"))).toBe("kill");
    expect(simulate(program, 0xc00000b7, 0)).toBe("kill");
  });

  it("kills the x32 ABI's numbering of a denied call instead of letting it through", () => {
    const program = seccompProgram();
    // The Kernel reaches the same call as `nr | 0x40000000`; an exact-match deny list alone would allow it.
    for (const name of ["mount", "bpf", "open_by_handle_at", "fsopen", "keyctl"]) {
      expect(simulate(program, SECCOMP_ARCH_X86_64, X32_SYSCALL_BIT | denied(name)), name).toBe("kill");
    }
    // A call that is allowed plainly is not allowed through the x32 numbering either.
    expect(simulate(program, SECCOMP_ARCH_X86_64, X32_SYSCALL_BIT | 0)).toBe("kill");
    expect(simulate(program, SECCOMP_ARCH_X86_64, 0)).toBe("allow");
  });

  it("packs instructions as the kernel reads struct sock_filter", () => {
    const bytes = seccompBytes(seccompProgram([["mount", 165]]));
    expect(bytes.length).toBe(9 * 8);
    // ld [4] (arch)
    expect([...bytes.subarray(0, 8)]).toEqual([0x20, 0x00, 0, 0, 4, 0, 0, 0]);
    // jeq AUDIT_ARCH_X86_64, +1, +0
    expect([...bytes.subarray(8, 16)]).toEqual([0x15, 0x00, 1, 0, 0x3e, 0x00, 0x00, 0xc0]);
    // ret KILL_PROCESS
    expect([...bytes.subarray(16, 24)]).toEqual([0x06, 0x00, 0, 0, 0x00, 0x00, 0x00, 0x80]);
    // ld [0] (nr)
    expect([...bytes.subarray(24, 32)]).toEqual([0x20, 0x00, 0, 0, 0, 0, 0, 0]);
    // jge the x32 bit, +3 (the KILL_PROCESS return after the EPERM one)
    expect([...bytes.subarray(32, 40)]).toEqual([0x35, 0x00, 3, 0, 0x00, 0x00, 0x00, 0x40]);
    // jeq 165, +1 (the EPERM return past the allow)
    expect([...bytes.subarray(40, 48)]).toEqual([0x15, 0x00, 1, 0, 165, 0, 0, 0]);
    expect([...bytes.subarray(56, 64)]).toEqual([0x06, 0x00, 0, 0, 0x01, 0x00, 0x05, 0x00]);
  });

  it("every denied number is unique and the filter is x86-64 Linux only", () => {
    expect(new Set(DENIED_SYSCALLS.map(([, nr]) => nr)).size).toBe(DENIED_SYSCALLS.length);
    expect(seccompSupported("x64", "linux")).toBe(true);
    expect(seccompSupported("arm64", "linux")).toBe(false);
    expect(seccompSupported("x64", "darwin")).toBe(false);
  });
});
