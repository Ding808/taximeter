import { z } from "zod";
import { version as packageVersion } from "../package.json";

export const version = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  .parse(packageVersion);
