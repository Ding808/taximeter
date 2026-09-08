# Record the 20-second demo

`demo.gif` is an intentional transparent GIF placeholder, not a recording of real
payments. The included simulation runs entirely against a local fixture and an
in-memory ledger. Its signatures and settlement reports are synthetic.

From a source checkout, prepare the built package:

```sh
npm ci
npm run build
node docs/demo.mjs
```

The simulation prints 20 allowed payments, the documented 402 block for payment
21, and an exact total of `140` atomic units. It creates no wallet, key, or persistent
ledger and closes its listeners when finished.

## VHS

Install VHS and its ffmpeg/ttyd prerequisites from the
[official VHS instructions](https://github.com/charmbracelet/vhs#installation).
Run from the repository root on a system supported by VHS (WSL is suitable on Windows):

```sh
vhs docs/demo.tape
```

The tape types exactly `node docs/demo.mjs`, then leaves the resulting block and
total visible. It writes `docs/demo.gif` at 960×660. Review the output before
committing the replacement; it must fit within the package's 2 MB tarball limit.

## asciinema alternative

With asciinema and agg installed from their official projects, record the same
script and convert it:

```sh
mkdir -p tmp
asciinema rec --cols 100 --rows 30 --command "node docs/demo.mjs" tmp/demo.cast
agg tmp/demo.cast docs/demo.gif
```

Run these commands in a POSIX shell or WSL. Do not enter account data,
wallet material, or real payment authorizations while recording. The expected
terminal script is only the local demo command above.

The native Windows release verification executes the simulation itself. VHS and
asciinema encoding are optional recording tools and are not package dependencies.
