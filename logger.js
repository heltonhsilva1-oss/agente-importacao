'use strict';
// Logger simples com timestamp — substitui o firebase-functions/logger

const logger = {
  info:  (...a) => console.log( new Date().toISOString(), '[INFO] ', ...a),
  warn:  (...a) => console.warn( new Date().toISOString(), '[WARN] ', ...a),
  error: (...a) => console.error(new Date().toISOString(), '[ERROR]', ...a),
};

module.exports = { logger };
