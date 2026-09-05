#!/usr/bin/env python3
"""
The checks that must pass before Glance is allowed to read anything.

The brief asks for one of these by name: the Linux blindlist is mirrored from
`TITLE_BLIND` in `daemon/src/context.ts`, "with a build check that fails if the
two drift." A password manager added to the Mac's list and forgotten here would
otherwise be silently readable on this machine, and nothing would say so.

Run it directly:  python3 check.py
"""

from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import blindlist

CONTEXT_TS = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "packages", "daemon", "src", "context.ts"
)

failures: list[str] = []
checks = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if ok:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}{(' — ' + detail) if detail else ''}")
        failures.append(name)


def title_blind() -> list[str]:
    """`TITLE_BLIND` as the daemon actually declares it."""
    with open(CONTEXT_TS, encoding="utf8") as handle:
        source = handle.read()
    m = re.search(r"export const TITLE_BLIND = \[(.*?)\];", source, re.S)
    if not m:
        return []
    return re.findall(r'"([^"]+)"', m.group(1))


print("blindlist drift")
mac = title_blind()
check("TITLE_BLIND was found in context.ts", bool(mac), f"looked in {CONTEXT_TS}")

for bundle in mac:
    check(
        f"{bundle} has an answer here",
        bundle in blindlist.COUNTERPARTS,
        "add it to COUNTERPARTS — an empty tuple if it has no Linux counterpart, "
        "which is a claim, not an omission",
    )

for bundle in blindlist.COUNTERPARTS:
    check(f"{bundle} is still on the Mac's list", bundle in mac,
          "it was removed there; remove it here too rather than leaving a stale entry")

print("\nblindlist behavior")
# The products the list exists for, as they actually present themselves here.
for cls in ("1password", "Bitwarden", "keepassxc", "org.kde.kwalletmanager5", "seahorse"):
    check(f"{cls} is refused by class", blindlist.is_blind(cls, None, None))

check("a window that merely mentions one is not refused",
      not blindlist.is_blind("firefox", None, "Notes about 1Password migration"),
      "substring matching would blind a note about a password manager")
check("an ordinary window is readable", not blindlist.is_blind("konsole", os.getpid(), "zsh"))
check("nothing known at all is refused",
      blindlist.is_blind(None, None, None),
      "when neither class nor exe can be read, refusing is the safe answer")
check("this very process is matched by its own exe",
      blindlist.exe_for(os.getpid()) is not None,
      "/proc/<pid>/exe should resolve for our own pid")

print(f"\n{checks - len(failures)}/{checks} checks passed")
if failures:
    print("failed: " + ", ".join(failures))
sys.exit(1 if failures else 0)
