import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderBannerText } from "../../src/ui/banner.js";
import { renderConfirmFrame, renderSelectFrame } from "../../src/ui/branded-prompts.js";
import { createTheme } from "../../src/ui/theme.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/branding-acceptance");
const UPDATE = process.env.UPDATE_BRANDING_FIXTURES === "1";
const theme = createTheme(true);
const CHOICES = [
  { value: "pro", label: "Install moeicons pro" },
  { value: "free", label: "Install moeicons free" },
  { value: "manage", label: "Manage project icons" },
];

const FRAMES: Record<string, string> = {
  "banner-80-color.txt": renderBannerText({ columns: 80, color: true }),
  "banner-80-nocolor.txt": renderBannerText({ columns: 80, color: false }),
  "banner-51.txt": renderBannerText({ columns: 51, color: true }),
  "select-active.txt": renderSelectFrame({ state: "active", cursor: 1, options: CHOICES }, "Choose an option", theme),
  "select-submit.txt": renderSelectFrame({ state: "submit", cursor: 1, options: CHOICES }, "Choose an option", theme),
  "select-cancel.txt": renderSelectFrame({ state: "cancel", cursor: 1, options: CHOICES }, "Choose an option", theme),
  "confirm-yes.txt": renderConfirmFrame({ state: "active", value: true }, "Install into this project?", theme),
  "confirm-no.txt": renderConfirmFrame({ state: "active", value: false }, "Install into this project?", theme),
  "confirm-submit-yes.txt": renderConfirmFrame({ state: "submit", value: true }, "Install into this project?", theme),
  "confirm-submit-no.txt": renderConfirmFrame({ state: "submit", value: false }, "Install into this project?", theme),
  "confirm-cancelled.txt": renderConfirmFrame({ state: "cancel", value: true }, "Install into this project?", theme),
};

describe("branding acceptance fixtures", () => {
  it("match the current renderer output (set UPDATE_BRANDING_FIXTURES=1 to refresh)", () => {
    mkdirSync(DIR, { recursive: true });
    for (const [name, body] of Object.entries(FRAMES)) {
      const path = join(DIR, name);
      const serialized = body.endsWith("\n") ? body : `${body}\n`;
      if (UPDATE) writeFileSync(path, serialized);
      expect(readFileSync(path, "utf8"), name).toBe(serialized);
    }
  });
});
