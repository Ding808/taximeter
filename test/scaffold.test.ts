import { expect, test } from "vitest";
import { version } from "../src/index";

test("the release has a stable version", () => {
  expect(version).toBe("0.1.0");
});
