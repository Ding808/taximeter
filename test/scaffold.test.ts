import { expect, test } from "vitest";
import { version as packageVersion } from "../package.json";
import { version } from "../src/index";

test("the release has a stable version", () => {
  expect(version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  expect(version).toBe(packageVersion);
});
