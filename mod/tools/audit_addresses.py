"""Checks every game address the base mod declares against your sonic.exe (SADX PC 2004).

    py -3 -m pip install capstone pefile
    py -3 mod/tools/audit_addresses.py "<SADX folder>\\sonic.exe" mod/sadx-multiplayer/source

Run it after changing mod/sadx-multiplayer.patch or moving the base mod to another commit. It reports:
  start   a function declared or hooked at an address that isn't a function start (nothing calls it and it
          doesn't follow padding): CCL_Enable was declared on its final `ret`.
  regs    a usercall whose function reads first registers the declaration doesn't pass: InitKuzu was declared
          with EBX on IsRangeIn, which reads EAX and ECX (the Casinopolis fan crash).
  cdecl   a plain call (FunctionPointer, TaskFunc, hooks) on a function that reads registers as arguments.
  shared  one address under two different names: TwinkleMaskBlock was Speed Highway's function.
Registers read only after a branch aren't followed, so a declared register the scan doesn't see is not
reported; extra registers are. Every finding needs a look at the disassembly before changing anything.
"""
import collections
import pathlib
import re
import struct
import sys

import pefile
from capstone import CS_ARCH_X86, CS_MODE_32, Cs
from capstone.x86 import X86_OP_IMM, X86_OP_MEM, X86_OP_REG

exe, src = sys.argv[1], pathlib.Path(sys.argv[2])
pe = pefile.PE(exe, fast_load=True)
base = pe.OPTIONAL_HEADER.ImageBase
img = pe.get_memory_mapped_image()
text = next(s for s in pe.sections if s.Name.rstrip(b"\0") == b".text")
t0, t1 = base + text.VirtualAddress, base + text.VirtualAddress + text.Misc_VirtualSize

# Every address something calls, jumps to, or stores as a pointer.
targets = set()
for i in range(len(img) - 5):
    if img[i] in (0xE8, 0xE9):
        dest = base + i + 5 + struct.unpack_from("<i", img, i + 1)[0]
        if t0 <= dest < t1:
            targets.add(dest)
for i in range(len(img) - 4):
    value = struct.unpack_from("<I", img, i)[0]
    if t0 <= value < t1:
        targets.add(value)


def is_function_start(addr):
    return addr in targets or img[addr - base - 1] in (0x90, 0xCC, 0xC3) or img[addr - base - 3] == 0xC2


md = Cs(CS_ARCH_X86, CS_MODE_32)
md.detail = True
GPR = {"eax", "ebx", "ecx", "edx", "esi", "edi"}
CANON = {}
for full, parts in {"eax": "al ah ax", "ebx": "bl bh bx", "ecx": "cl ch cx", "edx": "dl dh dx",
                    "esi": "si", "edi": "di"}.items():
    CANON[full] = full
    for part in parts.split():
        CANON[part] = full


def register_inputs(addr, limit=80):
    """Registers read before being written along the fall-through path from the entry."""
    written, first = set(), set()
    for n, ins in enumerate(md.disasm(img[addr - base: addr - base + 600], addr)):
        if n >= limit or ins.mnemonic in ("ret", "jmp", "int3"):
            break
        ops = ins.operands
        regs = [CANON.get(ins.reg_name(o.reg)) for o in ops if o.type == X86_OP_REG]
        if ins.mnemonic == "push" and regs:
            continue  # saving a callee-saved register (or passing it on: the declaration has to say so)
        if ins.mnemonic == "lea" and len(ops) == 2 and ops[1].type == X86_OP_MEM and ops[1].mem.disp == 0 \
                and ops[1].mem.index == 0 and ops[0].reg == ops[1].mem.base:
            continue  # lea ecx, [ecx]: alignment filler
        if len(ops) == 2 and ops[0].type == X86_OP_REG and (
                (ins.mnemonic in ("xor", "sub") and ops[1].type == X86_OP_REG and ops[0].reg == ops[1].reg)
                or (ins.mnemonic == "or" and ops[1].type == X86_OP_IMM and ops[1].imm & 0xFFFFFFFF == 0xFFFFFFFF)
                or (ins.mnemonic == "and" and ops[1].type == X86_OP_IMM and ops[1].imm == 0)):
            written.add(regs[0])  # sets the register whatever it held
            continue
        if ins.mnemonic == "call":
            written |= {"eax", "ecx", "edx"}  # clobbered: anything read afterwards isn't an argument
            continue
        read, write = ins.regs_access()
        for r in read:
            name = CANON.get(ins.reg_name(r))
            if name in GPR and name not in written:
                first.add(name)
        for r in write:
            name = CANON.get(ins.reg_name(r))
            if name in GPR:
                written.add(name)
    return first


REG = {"EAX": "eax", "EBX": "ebx", "ECX": "ecx", "EDX": "edx", "ESI": "esi", "EDI": "edi",
       "AL": "eax", "BL": "ebx", "CL": "ecx", "DL": "edx", "AX": "eax", "BX": "ebx", "CX": "ecx", "DX": "edx",
       "SI": "esi", "DI": "edi"}
CALL = r"(0x[0-9A-Fa-f]{5,8})"
PATTERNS = [  # (regex, kind, convention, name group, address group, register group)
    (rf"\b(FunctionPointer|StdcallFunctionPointer)\s*\(\s*[^,]+,\s*(\w+)\s*,.*?{CALL}\s*\)", "plain", 2, 3, None),
    (rf"\bFastcallFunctionPointer\s*\(\s*[^,]+,\s*(\w+)\s*,.*?{CALL}\s*\)", "fastcall", 1, 2, None),
    (rf"\bThiscallFunctionPointer\s*\(\s*[^,]+,\s*(\w+)\s*,.*?{CALL}\s*\)", "thiscall", 1, 2, None),
    (rf"\b(?:VoidFunc|TaskFunc|ObjectFunc)\s*\(\s*(\w+)\s*,\s*{CALL}\s*\)", "plain", 1, 2, None),
    (rf"\bUsercallFunc\s*\(\s*[^,]+,\s*(\w+)\s*,\s*\([^)]*\)\s*,\s*\([^)]*\)\s*,\s*{CALL}\s*,\s*\w+\s*((?:,\s*\w+\s*)*)\)",
     "usercall", 1, 2, 3),
    (rf"\bUsercallFuncVoid\s*\(\s*(\w+)\s*,\s*\([^)]*\)\s*,\s*\([^)]*\)\s*,\s*{CALL}\s*((?:,\s*\w+\s*)*)\)",
     "usercall", 1, 2, 3),
    (rf"\bFastUsercallHookPtr\s*<\s*[^,<>]*(?:<[^<>]*>)?[^,<>]*,\s*\w+\s*((?:,\s*\w+\s*)*)>\s*(\w+)\s*\(\s*{CALL}",
     "usercall", 2, 3, 1),
    (rf"\b(?:FastFunctionHook|FastFunctionHookPtr|FunctionHook|TaskHook)\s*(?:<[^;{{]*?>)?\s+(\w+)\s*\(\s*(?:\(intptr_t\))?\s*{CALL}",
     "plain", 1, 2, None),
    (rf"(\w+)\s*=\s*GenerateUsercallWrapper\s*<[^>]*>\s*\(\s*\w+\s*,\s*{CALL}\s*((?:,\s*\w+\s*)*)\)", "usercall", 1, 2, 3),
]

decls = []
for path in sorted(src.rglob("*")):
    if path.suffix not in (".cpp", ".h", ".hpp"):
        continue
    text_ = path.read_text(errors="ignore")
    for pattern, conv, name_g, addr_g, regs_g in PATTERNS:
        for m in re.finditer(pattern, text_):
            regs = None
            if regs_g:
                regs = {REG.get(r.strip().lstrip("r")) for r in m.group(regs_g).split(",") if r.strip()} - {None}
            line = text_.count("\n", 0, m.start()) + 1
            decls.append((f"{path.relative_to(src).as_posix()}:{line}", m.group(name_g), int(m.group(addr_g), 16), conv, regs))

findings = collections.defaultdict(list)
names = collections.defaultdict(set)
for where, name, addr, conv, regs in decls:
    names[addr].add(name.removesuffix("_h").removesuffix("_hook").removesuffix("_t"))
    if not t0 <= addr < t1:
        continue
    label = f"{where} {name} @0x{addr:06X}"
    if not is_function_start(addr):
        findings["start"].append(label)
    inputs = register_inputs(addr)
    allowed = {"usercall": regs or set(), "fastcall": {"ecx", "edx"}, "thiscall": {"ecx"}}.get(conv, set())
    if inputs - allowed:
        findings["regs" if conv == "usercall" else "cdecl"].append(
            f"{label} declared={sorted(allowed)} reads first={sorted(inputs)}")
for addr, group in sorted(names.items()):
    if len(group) > 1:
        findings["shared"].append(f"0x{addr:06X}: {', '.join(sorted(group))}")

print(f"{len(decls)} declarations checked")
for kind in ("start", "regs", "cdecl", "shared"):
    print(f"\n{kind}: {len(findings[kind])}")
    for item in findings[kind]:
        print(f"  {item}")
