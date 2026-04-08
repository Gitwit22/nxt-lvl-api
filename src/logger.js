function log(level, message, meta) {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        ...(meta ? { meta } : {}),
    };
    const line = JSON.stringify(entry);
    if (level === "error") {
        // eslint-disable-next-line no-console
        console.error(line);
    }
    else {
        // eslint-disable-next-line no-console
        console.log(line);
    }
}
export const logger = {
    info: (message, meta) => log("info", message, meta),
    warn: (message, meta) => log("warn", message, meta),
    error: (message, meta) => log("error", message, meta),
    debug: (message, meta) => log("debug", message, meta),
};
