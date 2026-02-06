import { config } from '../config.js';

export enum LogLevel {
  ERROR = 1,
  INFO = 2,
  DEBUG = 3,
}

export interface LogContext {
  userId?: string;
  guildId?: string;
  channelId?: string;
  command?: string;
  [key: string]: string | number | boolean | undefined;
}

class Logger {
  private level: LogLevel;

  constructor(level: number) {
    this.level = level as LogLevel;
  }

  private formatContext(context?: LogContext): string {
    if (!context || Object.keys(context).length === 0) {
      return '';
    }
    const parts = Object.entries(context)
      .filter(([_, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`);
    return parts.length > 0 ? ` [${parts.join(' ')}]` : '';
  }

  private formatMessage(level: string, message: string, context?: LogContext): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level}]${this.formatContext(context)} ${message}`;
  }

  error(message: string, context?: LogContext): void {
    console.error(this.formatMessage('ERROR', message, context));
  }

  warn(message: string, context?: LogContext): void {
    if (this.level >= LogLevel.INFO) {
      console.warn(this.formatMessage('WARN', message, context));
    }
  }

  info(message: string, context?: LogContext): void {
    if (this.level >= LogLevel.INFO) {
      console.info(this.formatMessage('INFO', message, context));
    }
  }

  debug(message: string, context?: LogContext): void {
    if (this.level >= LogLevel.DEBUG) {
      console.debug(this.formatMessage('DEBUG', message, context));
    }
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }
}

export const logger = new Logger(config.logLevel);
