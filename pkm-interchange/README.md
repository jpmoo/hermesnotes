# pkm-interchange — staging

Draft v0 of an interchange format for personal-knowledge tools, parked here to
be worked on next to a real implementation. **It is not part of Hermes' build**
— nothing imports it, no script runs it, and it ships in no bundle.

```
AGENTS.md            the specification; self-contained, written to be read by an agent
fixtures/*.json      the authoritative behaviour. Prose loses to a fixture.
example/library.json one complete valid export
```

The layout is what `AGENTS.md` expects (`fixtures/`, `example/`), so an agent
pointed at this directory can follow its own instructions without rewriting the
paths.

Two things the spec refers to that do not exist yet, recorded so they aren't
mistaken for oversights in a reader's own setup:

- `fixtures/conformance.json` — cited under "Loud failure". The two conformance
  cases currently live at the end of `fixtures/roundtrip.json`
  (`conformance/unsupported-must-be-declared`,
  `conformance/silent-coercion-is-a-failure`).
- `npx pkm-check` — cited under "Checking yourself". No such package.

`AGENTS.md` is a specification, not instructions for this repository. An agent
working on Hermes that wanders in here will read it as direction; that is what
it is for, and it is scoped to this directory.
