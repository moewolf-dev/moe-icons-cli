import { describe, expect, it } from "vitest";
import { verifyPublishEvidence } from "../scripts/verify-publish-evidence.mjs";

const candidate = "a".repeat(64);
const pin = "b".repeat(40);
const intent = {
  schemaVersion: 1,
  version: "0.0.19",
  tag: "v0.0.19",
  candidateSha256: candidate,
  releaseCommit: "c".repeat(40),
  pinCommit: pin,
  stage: "publish-intent",
};
const accepted = { schemaVersion: 1, version: "0.0.19", tag: "v0.0.19", stage: "publish-command-succeeded" };
const acceptedWithIntegrity = { ...accepted, stage: "registry-accepted", npmIntegrity: "sha512-AAAA" };

const verify = (overrides = {}) =>
  verifyPublishEvidence({ intent, accepted, tag: "v0.0.19", candidate, pin, ...overrides });

describe("publish evidence consumer", () => {
  it("accepts the original intent continued through the command stage", () => {
    expect(verify()).toMatchObject({ version: "0.0.19", pinCommit: pin, stage: "publish-command-succeeded" });
  });

  it("accepts a resumed version once the registry read succeeded", () => {
    expect(verify({ accepted: acceptedWithIntegrity, requireAccepted: true })).toMatchObject({ stage: "registry-accepted" });
  });

  it("refuses to write a receipt before the version is readable", () => {
    expect(() => verify({ requireAccepted: true })).toThrow(/must be read back/);
  });

  it("refuses a different candidate, pin or version", () => {
    expect(() => verify({ candidate: "d".repeat(64) })).toThrow(/candidateSha256/);
    expect(() => verify({ pin: "e".repeat(40) })).toThrow(/pinCommit/);
    expect(() => verify({ accepted: { ...accepted, version: "0.0.20" } })).toThrow(/version must equal/);
    expect(() => verify({ tag: "v0.0.20" })).toThrow(/tag must match/);
  });

  it("refuses unknown stages instead of treating them as success", () => {
    expect(() => verify({ accepted: { ...accepted, stage: "validated" } })).toThrow(/known recovery stage/);
  });
});
