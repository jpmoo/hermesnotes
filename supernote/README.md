# Supernote

Plugins for the Supernote Manta that speak pkm-interchange.

Nothing is built yet. This file exists so the first decision is made on purpose
rather than discovered halfway through, and so the parts that are *already*
settled by rules elsewhere in this repo are not re-litigated.

## Why this is worth building, in the format's own terms

`pkm-interchange/LIMITS.md` states its own bias in the preamble, and it is the
reason this folder is interesting:

> One consumer was ported onto one producer, so this finds what *both* of them
> feel and is blind to everything neither does.

Talaria is the only thing that has ever lived on this format, and Talaria is
Hermes-shaped: flat blocks, collections, a mirror. A Supernote client is not.
It is a device with pages, pens, and a proprietary file format, whose native
unit is a stroke and whose native gesture is writing rather than filing.

So this is the first honest test of the claim the format is written to support —
*can two applications that have never heard of each other exchange a library* —
and every place it does not fit is worth more than a working feature. Those go
in `LIMITS.md`, named, in the shape that file already uses.

## What is already decided

**It reaches Hermes only through pkm-interchange.** The same rule Talaria works
under. Where the spec cannot say something, say so and ask before going around
it — and if you go around it, the reaching-past is named in `LIMITS.md` and
confined to one place somebody can find. Silence is the thing that is not
allowed.

**A limit found here is worth more than a workaround.** See above. This folder's
best possible output is a shorter `LIMITS.md`, not a longer feature list.

**Unknown fields survive byte-identical.** In both directions. A device that
drops what it does not model is a device that quietly deletes somebody's
library one sync at a time.

**American spellings**, as everywhere in this repo.

## What is not decided

Written down as questions rather than guessed at:

1. **What the plugin surface actually is.** A sideloaded Android APK, a Ratta
   partner-app SDK, or no on-device code at all — a host-side tool that meets
   the device through its file system, USB, or whichever cloud sync it is set
   to. These are three different projects sharing a name, and only the third
   can start today without a device SDK in hand.
2. **Which direction goes first.** Hermes onto the device — today's tasks and
   notes as something readable and markable — or the device back into Hermes,
   where a page of handwriting becomes a block. The second is the harder and
   more interesting half, and needs an answer about `.note` before it can
   begin.
3. **Which binding.** `file` (an export handed across) or the live HTTP binding
   (L4, talking to a running Hermes). Mostly follows from 1: a device that is
   sometimes on a network and often not is the case the file binding was
   written for, and is also the case Talaria's mirror already solved once.
4. **What `.note` costs.** It is proprietary. Reverse-engineered parsers exist
   and their fidelity is the open question — whether a page can be read well
   enough to be worth carrying, and whether anything can be written back at all
   without corrupting a notebook somebody cares about.

## Not a workspace member yet

`pnpm-workspace.yaml` is untouched. It gains an entry when there is a package
here, not before — a workspace glob matching an empty directory is a build
step that exists to do nothing.
