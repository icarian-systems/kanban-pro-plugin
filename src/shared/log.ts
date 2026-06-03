const PREFIX = '[Kanban Pro]';

const isProd = (() => {
  try {
    return typeof process !== 'undefined' && process.env?.NODE_ENV === 'production';
  } catch {
    return false;
  }
})();

export const log = {
  info: (...args: unknown[]) => console.log(PREFIX, ...args),
  warn: (...args: unknown[]) => console.warn(PREFIX, ...args),
  error: (...args: unknown[]) => console.error(PREFIX, ...args),
  debug: (...args: unknown[]) => {
    if (!isProd) console.debug(PREFIX, ...args);
  },
};
