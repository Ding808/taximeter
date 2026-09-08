#!/usr/bin/env node
import { CommanderError } from "commander";
import { runCli } from "./program";

runCli(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof CommanderError && error.exitCode === 0) return;
  if (!(error instanceof CommanderError))
    process.stderr.write(
      `Taximeter: ${error instanceof Error ? error.message : "command failed"}\n`,
    );
  process.exitCode = 1;
});
