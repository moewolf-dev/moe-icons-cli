"use strict";

var MIN_MAJOR = 22;
var LTS_URL = "https://nodejs.org/en/download";
var EOL_URL = "https://nodejs.org/en/about/eol";

function parseMajor(version) {
  var raw = String(version || "").replace(/^v/, "");
  var major = parseInt(raw.split(".")[0], 10);
  if (!isFinite(major)) return null;
  return major;
}

function assertSupportedNode(version) {
  var major = parseMajor(version);
  var display = String(version || "").charAt(0) === "v" ? String(version) : "v" + String(version);
  if (major === null || major < MIN_MAJOR) {
    return {
      ok: false,
      major: major,
      message:
        "moeicons requires Node.js " + MIN_MAJOR + " or later (you have " + display + ").\n" +
        "Node " + (major === null ? display : major) + " is outside the supported line. Node 20 reached end-of-life on 2026-03-24 and no longer receives security patches.\n" +
        "Install the current Node.js LTS: " + LTS_URL + "\n" +
        "Policy: " + EOL_URL + "\n",
    };
  }
  return { ok: true, major: major, message: "" };
}

module.exports = {
  MIN_MAJOR: MIN_MAJOR,
  LTS_URL: LTS_URL,
  parseMajor: parseMajor,
  assertSupportedNode: assertSupportedNode,
};
