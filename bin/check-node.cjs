"use strict";

/**
 * P0-00 / REF-07: zero-dependency Node preflight.
 *
 * This file must run on every Node version the CLI might meet, including an
 * unsupported one. It therefore uses only CommonJS and legacy-safe syntax and
 * never imports `dist/`, npm dependencies or ESM.
 */

var MIN_MAJOR = 24;
var LTS_URL = "https://nodejs.org/en/download";
var EOL_URL = "https://nodejs.org/en/about/eol";
var DOCS_URL = "https://moeicons.com/docs/cli-update";

function parseMajor(version) {
  var raw = String(version || "").replace(/^v/, "");
  var major = parseInt(raw.split(".")[0], 10);
  if (!isFinite(major)) return null;
  return major;
}

function envSet(env, name) {
  return env && typeof env[name] === "string" && env[name].length > 0;
}

/**
 * Detect version managers only from environment variables or a known install
 * directory. An unknown setup gets the official download page, never a command
 * that could replace the system Node.
 */
function detectManagers(env) {
  var managers = [];
  if (envSet(env, "NVM_DIR") || envSet(env, "NVM_BIN")) managers.push("nvm");
  if (envSet(env, "FNM_MULTISHELL_PATH") || envSet(env, "FNM_DIR")) managers.push("fnm");
  if (envSet(env, "VOLTA_HOME")) managers.push("volta");
  if (envSet(env, "ASDF_DIR") || envSet(env, "ASDF_DATA_DIR")) managers.push("asdf");
  return managers;
}

function upgradeCommands(managers) {
  var commands = [];
  for (var i = 0; i < managers.length; i += 1) {
    if (managers[i] === "nvm") commands.push("nvm install 24 && nvm use 24");
    if (managers[i] === "fnm") commands.push("fnm install 24 && fnm use 24");
    if (managers[i] === "volta") commands.push("volta install node@24");
    if (managers[i] === "asdf")
      commands.push("asdf install nodejs latest:24 && asdf global nodejs latest:24");
  }
  return commands;
}

function formatHint(env) {
  var managers = detectManagers(env || {});
  var commands = upgradeCommands(managers);
  var lines = ["Requires Node.js " + MIN_MAJOR + " LTS."];
  if (commands.length > 0) {
    lines.push("Detected version manager. Upgrade with:");
    for (var i = 0; i < commands.length; i += 1) lines.push("  " + commands[i]);
  } else {
    lines.push("Install the current Node.js 24 LTS from: " + LTS_URL);
    lines.push("Use your operating system's installer or a version manager you already use.");
  }
  lines.push(
    "Then reopen the terminal and verify: node -v  (expect v24 or later) and moeicons --version.",
  );
  return lines.join("\n");
}

function formatHuman(version, env) {
  var display = String(version || "").charAt(0) === "v" ? String(version) : "v" + String(version);
  return (
    "moeicons requires Node.js " +
    MIN_MAJOR +
    " or later (you have " +
    display +
    ").\n" +
    "Node.js 20 and 22 are no longer supported by this CLI; they do not receive security patches on this line.\n" +
    formatHint(env) +
    "\nPolicy: " +
    EOL_URL +
    "\nDocs: " +
    DOCS_URL +
    "\n"
  );
}

/**
 * @param {string} version process.version
 * @param {{env?: Record<string,string|undefined>}} [options]
 */
function assertSupportedNode(version, options) {
  var env = (options && options.env) || {};
  var major = parseMajor(version);
  var display = String(version || "").charAt(0) === "v" ? String(version) : "v" + String(version);
  if (major === null || major < MIN_MAJOR) {
    return {
      ok: false,
      major: major,
      code: "NODE_VERSION_UNSUPPORTED",
      current: display,
      required: ">=" + MIN_MAJOR,
      hint: formatHint(env),
      message: formatHuman(version, env),
    };
  }
  return {
    ok: true,
    major: major,
    code: "OK",
    current: display,
    required: ">=" + MIN_MAJOR,
    message: "",
  };
}

function startupFailureJson(result) {
  return {
    ok: false,
    code: result.code || "NODE_VERSION_UNSUPPORTED",
    message: result.message,
    current: result.current,
    required: result.required,
    hint: result.hint,
  };
}

module.exports = {
  MIN_MAJOR: MIN_MAJOR,
  LTS_URL: LTS_URL,
  EOL_URL: EOL_URL,
  DOCS_URL: DOCS_URL,
  parseMajor: parseMajor,
  detectManagers: detectManagers,
  upgradeCommands: upgradeCommands,
  assertSupportedNode: assertSupportedNode,
  startupFailureJson: startupFailureJson,
};
