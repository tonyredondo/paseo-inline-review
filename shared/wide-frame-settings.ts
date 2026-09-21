/** User flag for the wide reading-frame experiment (host-scoped storage). */
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const wideFrameSettings = defineSettings({
  id: "inline-review-wide-frame",
  scope: "host",
  version: 1,
    // Per-field default: an empty store reads as disabled instead of invalid.
  schema: z.object({ wideFrame: z.boolean().default(false) }),
});
