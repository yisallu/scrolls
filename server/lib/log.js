// Minimal leveled logger. journalctl already timestamps every line, so the prefix
// stays short: level + subsystem.
import config from "../config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, tag, args) {
  if (LEVELS[level] < threshold) return;
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  sink(`[${tag}]`, ...args);
}

export function logger(tag) {
  return {
    debug: (...a) => emit("debug", tag, a),
    info: (...a) => emit("info", tag, a),
    warn: (...a) => emit("warn", tag, a),
    error: (...a) => emit("error", tag, a),
  };
}

export default logger;
