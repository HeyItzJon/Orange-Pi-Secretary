// log.js — prefixed logging, one place to turn the volume down.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL || "info"] || LEVELS.info;

function emit(level, scope, args) {
  if (LEVELS[level] < threshold) return;
  const stamp = new Date().toISOString().slice(11, 19);
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(`${stamp} [${scope}]`, ...args);
}

export function logger(scope) {
  return {
    debug: (...a) => emit("debug", scope, a),
    info: (...a) => emit("info", scope, a),
    warn: (...a) => emit("warn", scope, a),
    error: (...a) => emit("error", scope, a),
  };
}
