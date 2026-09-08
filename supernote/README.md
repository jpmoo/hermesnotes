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

## The first thing to build

Decided. **Lasso a region on the page and send it to Hermes as a block.**

- The writer picks what it becomes: a text block or a task. Their choice, on
  the device, before it goes.
- They type a title.
- The block arrives in Hermes carrying **an image of the lassoed area as an
  attachment**.

Two notes on that, one of which is a wall.

**The type is picked from what Hermes declares, never from a name.** The chooser
offers whatever the library actually has, resolved through profiles — a type
declaring the `task` profile is the task option, whatever it is called. Matching
on the string `"Task"` or `"Text"` is the bug this repo names in its own
invariants, and it has already cost one import of three hundred notes.

**And the attachment is the open limit, exactly.** `LIMITS.md` says an
attachment can be named and not carried: the format has a value kind that says
*there is a file called this* and no channel for the bytes. The first feature of
the second consumer needs to send a PNG to Hermes, so the very first thing built
here walks into the one thing v0 cannot do.

That is not bad luck; it is the list working. A limit found by one client is a
guess about the format, and the same limit found by a second client that shares
none of the first one's shape is evidence. This one is now both.

## What is not decided

Written down as questions rather than guessed at:

1. **How the bytes get there.** See above. Either the format grows the channel —
   the shape proposed at the end of that `LIMITS.md` entry — or this reaches
   past the binding to Hermes' own attachment route for one call, named and
   confined. The second is explicitly allowed and explicitly must not be
   silent. The first is better and larger.
2. **What the Ratta SDK actually gives a plugin.** Whether a lasso selection is
   exposed to plugin code at all, whether a plugin can rasterize the selected
   region, what language and lifecycle it runs under, and what network access it
   has. Nothing here should be designed against a guess about this.
3. **Which binding.** `file` (an export handed across) or the live HTTP binding
   (L4, talking to a running Hermes). A device that is sometimes on a network
   and often not is the case Talaria's mirror already solved once, and the same
   answer may apply — send when it can, hold when it cannot.
4. **What `.note` costs.** It is proprietary. Reverse-engineered parsers exist
   and their fidelity is the open question. The first feature may not need it at
   all if the SDK can hand over a rendered region, which is the cheapest reason
   to find out what the SDK can do before anything else.

## Not a workspace member yet

`pnpm-workspace.yaml` is untouched. It gains an entry when there is a package
here, not before — a workspace glob matching an empty directory is a build
step that exists to do nothing.
