# Record the 20-second demo

`demo.gif` is a 20-second recording of the included simulation running on Windows,
captured on 2026-09-08. The simulation runs entirely against a local fixture and
an in-memory ledger. Its signatures and settlement reports are synthetic.

From a source checkout, prepare the built package:

```sh
npm ci
npm run build
node docs/demo.mjs
```

The simulation prints 20 allowed payments, the documented 402 block for payment
21, and an exact total of `140` atomic units. It creates no wallet, key, or persistent
ledger and closes its listeners when finished.

## Captured Windows recording

The shipped GIF captures an actual `cmd.exe` session through Windows ConPTY using
[node-pty 1.1.0](https://github.com/microsoft/node-pty). The recorder types
`node docs/demo.mjs`, stores the terminal's output with its original timing in an
asciicast v2 file, and waits until 20 seconds have elapsed. It checks the block and
exact ledger total in the captured output and requires the command shell to exit
successfully. The terminal is 104 columns by 32 rows.

[agg 1.9.0](https://github.com/asciinema/agg/releases/tag/v1.9.0) renders that capture
using Consolas at 18 px, line height 1.1, the GitHub dark theme, and a 20 fps cap.
The final frame is held long enough for the complete GIF to last 20 seconds.
The resulting GIF is 1049×653 and 96,519 bytes. The final block response and ledger
total remain visible together. No demo output is fabricated or replaced.

The local recording workspace is `E:\Taximeter-Demo`: it contains `demo.cast`,
`demo.gif`, `demo.mp4`, the raw terminal output, `record-demo.mjs`,
`render-demo.ps1`, and the downloaded tools. FFmpeg already installed on the
computer converts the GIF to an H.264 MP4 with one padding row and column for
even dimensions.
With that local workspace present, repeat the capture from PowerShell:

```powershell
node E:\Taximeter-Demo\record-demo.mjs
& E:\Taximeter-Demo\render-demo.ps1
Copy-Item E:\Taximeter-Demo\demo.gif E:\Taximeter\docs\demo.gif
```

The Windows recording helpers and their dependencies stay outside the repository
and npm package. The following alternatives work from other source checkouts.

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
asciinema rec --cols 104 --rows 32 --command "node docs/demo.mjs" tmp/demo.cast
agg tmp/demo.cast docs/demo.gif
```

This quick alternative uses agg's default final pause and produces a shorter GIF.
For a 20-second result, increase `--last-frame-duration` by the difference between
20 seconds and the measured GIF duration, then render again. The verified Windows
rendering helper calculates that pause automatically.

Run these commands in a POSIX shell or WSL. Do not enter account data,
wallet material, or real payment authorizations while recording. The expected
terminal script is only the local demo command above.

The Windows ConPTY/agg recording above was executed and visually checked. The VHS
and asciinema alternatives remain documented recipes, not verified Windows runs.
Recording tools are optional and are not package dependencies.
