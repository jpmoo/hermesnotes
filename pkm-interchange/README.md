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

```
check/               pkm-check — the runner, a reference adapter, and the mutants
```

The fixtures are now executable: a scenario like "a tool with no matrix view" is
capability data rather than English, so a runner can act on it. The case grammar
is in [fixtures/README.md](fixtures/README.md); nothing the suites *say* changed,
and every `why` is the original text.

```bash
node check/src/cli.js --self
```

One thing the spec refers to that still doesn't exist: `fixtures/conformance.json`,
cited under "Loud failure". Its two cases live at the end of
`fixtures/roundtrip.json` (`conformance/unsupported-must-be-declared`,
`conformance/silent-coercion-is-a-failure`) and are tagged level 3.

`AGENTS.md` is a specification, not instructions for this repository. An agent
working on Hermes that wanders in here will read it as direction; that is what
it is for, and it is scoped to this directory.
