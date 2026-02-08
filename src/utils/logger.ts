/**
 * Centralized Winston logger for discord-voice-bot
 * Replaces all console.log/warn/error calls
 */

import winston from 'winston';
import path from 'path';

// Log levels configuration
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// Create the Winston logger
const logger = winston.createLogger({
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
  },
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
  ),
  transports: [
    // Console transport with colorized output
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          let msg = `[${timestamp}] ${level}: ${message}`;
          if (Object.keys(meta).length > 0) {
            msg += ` ${JSON.stringify(meta)}`;
          }
          return msg;
        }),
      ),
    }),
    // File transport with JSON format
    new winston.transports.File({
      filename: path.join(process.cwd(), 'logs', 'app.log'),
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json(),
      ),
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    }),
  ],
});

// Add stream for Morgan or similar middleware compatibility
(logger as any).stream = {
  write: (message: string) => {
    logger.info(message.trim());
  },
};

export default logger;
